/**
 * Live connections keyed by (profile id, resolved database). Connects on
 * demand with a timeout, shares one in-flight attempt per key, reports every
 * state change, and hands out read-only-guarded drivers for read-only
 * profiles.
 */
import type { ConnRef, ConnectionProfile, ConnectionStatus } from '@shared/types';
import { AppError } from '../errors';
import { connectDriver } from '../db';
import { closeQuietly, errorMessage, withTimeout } from '../db/common';
import type { Driver } from '../db/driver';
import type { ConnectionRegistry } from '../services';
import { readOnlyDriver } from './guard';

export type ConnectFn = typeof connectDriver;

export interface RegistryDeps {
  getProfile(profileId: string): ConnectionProfile | undefined;
  listProfiles(): ConnectionProfile[];
  getPassword(profileId: string): Promise<string | null>;
  onStatus?(status: ConnectionStatus): void;
  connect?: ConnectFn;
}

interface Entry {
  status: ConnectionStatus;
  driver?: Driver;
  pending?: Promise<Driver>;
  /** Bumped on disconnect so a connect that finishes late is discarded. */
  generation: number;
}

const DEFAULT_CONNECT_TIMEOUT_SEC = 15;

export function connectTimeoutMs(profile: ConnectionProfile): number {
  const sec = Number(profile.options?.connectTimeoutSec);
  return (Number.isFinite(sec) && sec > 0 ? Math.min(sec, 600) : DEFAULT_CONNECT_TIMEOUT_SEC) * 1000;
}

/** The database a ref targets: the ref's, else the profile default. SQLite has a single file. */
export function resolveDatabase(profile: ConnectionProfile, ref: ConnRef): string {
  if (profile.kind === 'sqlite') return profile.database;
  return ref.database ?? profile.database;
}

const keyOf = (profileId: string, database: string) => `${profileId}\u0000${database}`;

export class Registry implements ConnectionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly connect: ConnectFn;

  constructor(private readonly deps: RegistryDeps) {
    this.connect = deps.connect ?? connectDriver;
  }

  listProfiles(): ConnectionProfile[] {
    return this.deps.listProfiles();
  }

  getProfile(profileId: string): ConnectionProfile | undefined {
    return this.deps.getProfile(profileId);
  }

  requireProfile(profileId: string): ConnectionProfile {
    const p = typeof profileId === 'string' ? this.deps.getProfile(profileId) : undefined;
    if (!p) throw new AppError('That connection no longer exists', 'NOT_FOUND');
    return p;
  }

  status(ref: ConnRef): ConnectionStatus {
    const profile = this.getProfile(ref.profileId);
    const database = profile ? resolveDatabase(profile, ref) : (ref.database ?? '');
    const entry = this.entries.get(keyOf(ref.profileId, database));
    return entry ? { ...entry.status } : { profileId: ref.profileId, database, state: 'disconnected' };
  }

  statuses(): ConnectionStatus[] {
    return [...this.entries.values()].map((e) => ({ ...e.status }));
  }

  private setStatus(entry: Entry, status: ConnectionStatus): void {
    entry.status = status;
    this.deps.onStatus?.({ ...status });
  }

  /** A connected driver for the ref (connecting first if needed); guarded when the profile is read-only. */
  async acquire(ref: ConnRef): Promise<Driver> {
    const profile = this.requireProfile(ref.profileId);
    const driver = await this.driverFor(profile, resolveDatabase(profile, ref));
    return profile.readOnly ? readOnlyDriver(driver) : driver;
  }

  /** Connect and report the resulting status; connection failures are returned, not thrown. */
  async connectRef(ref: ConnRef): Promise<ConnectionStatus> {
    const profile = this.requireProfile(ref.profileId);
    const database = resolveDatabase(profile, ref);
    try {
      await this.driverFor(profile, database);
    } catch {
      // The failure is recorded in the entry's status.
    }
    return this.status(ref);
  }

  private driverFor(profile: ConnectionProfile, database: string): Promise<Driver> {
    const key = keyOf(profile.id, database);
    let entry = this.entries.get(key);
    if (entry?.driver) return Promise.resolve(entry.driver);
    if (entry?.pending) return entry.pending;
    if (!entry) {
      entry = { status: { profileId: profile.id, database, state: 'disconnected' }, generation: 0 };
      this.entries.set(key, entry);
    }
    const pending = this.open(entry, profile, database);
    entry.pending = pending;
    return pending;
  }

  private async open(entry: Entry, profile: ConnectionProfile, database: string): Promise<Driver> {
    const generation = ++entry.generation;
    this.setStatus(entry, { profileId: profile.id, database, state: 'connecting' });
    const timeoutMs = connectTimeoutMs(profile);
    try {
      const password = profile.kind === 'sqlite' ? null : await this.deps.getPassword(profile.id);
      const attempt = this.connect(profile, password, database, { readOnly: profile.readOnly, connectTimeoutMs: timeoutMs });
      // The drivers have their own login timeouts; this outer one also covers DNS, TLS, and instance lookup stalls.
      const driver = await withTimeout(attempt, timeoutMs + 5000, `Timed out after ${Math.round(timeoutMs / 1000)}s`, (late) => void late.close());
      if (entry.generation !== generation) {
        await closeQuietly(() => driver.close());
        throw new AppError('Connection attempt was cancelled', 'CANCELLED');
      }
      const serverVersion = await driver.serverVersion().catch(() => undefined);
      entry.driver = driver;
      entry.pending = undefined;
      const status: ConnectionStatus = { profileId: profile.id, database, state: 'connected', connectedAt: new Date().toISOString() };
      if (serverVersion) status.serverVersion = serverVersion;
      this.setStatus(entry, status);
      return driver;
    } catch (err) {
      if (entry.generation === generation) {
        entry.pending = undefined;
        this.setStatus(entry, { profileId: profile.id, database, state: 'error', error: errorMessage(err) });
      }
      if (err instanceof AppError && err.code === 'CANCELLED') throw err;
      throw new AppError(`Could not connect to ${profile.name}${database && profile.kind !== 'sqlite' ? ` (${database})` : ''}: ${errorMessage(err)}`, 'CONNECT_FAILED');
    }
  }

  async disconnect(ref: ConnRef): Promise<ConnectionStatus> {
    const profile = this.getProfile(ref.profileId);
    const database = profile ? resolveDatabase(profile, ref) : (ref.database ?? '');
    await this.closeEntry(keyOf(ref.profileId, database));
    return this.status(ref);
  }

  /** Close every connection of a profile (after it was edited or deleted). */
  async disconnectProfile(profileId: string): Promise<void> {
    const prefix = `${profileId}\u0000`;
    await Promise.all([...this.entries.keys()].filter((k) => k.startsWith(prefix)).map((k) => this.closeEntry(k)));
  }

  private async closeEntry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.generation++;
    const driver = entry.driver;
    entry.driver = undefined;
    entry.pending = undefined;
    this.entries.delete(key);
    if (entry.status.state !== 'disconnected') this.deps.onStatus?.({ profileId: entry.status.profileId, database: entry.status.database, state: 'disconnected' });
    if (driver) await closeQuietly(() => driver.close());
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((k) => this.closeEntry(k)));
  }
}
