/**
 * Connection profiles as the UI sees them: CRUD with passwords in the secret
 * store, `hasPassword` derived from it, test connections, dbTool import, and
 * dropping live connections when a profile's connection fields change.
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ConnectionProfile,
  ImportDbtoolRequest,
  ImportResult,
  SaveConnectionRequest,
  TestConnectionRequest,
  TestConnectionResult
} from '@shared/types';
import { AppError } from '../errors';
import { dbtoolConfigDir } from '../paths';
import { closeQuietly, errorMessage, withTimeout } from '../db/common';
import { expandHome } from '../db/sqlite';
import { planDbtoolImport } from './import-dbtool';
import { connectTimeoutMs, type ConnectFn, type Registry } from './registry';
import type { CommandRunner, SecretStore } from './secrets';
import { connectionFieldsChanged, normalizeProfile, validateProfile, type ProfileStore } from './store';

export interface ManagerDeps {
  store: ProfileStore;
  secrets: SecretStore;
  registry: Registry;
  connect: ConnectFn;
  /** Called with the full list after every save, delete, or import. */
  onChanged?(profiles: ConnectionProfile[]): void;
  /** Runs `security` for dbTool Keychain import; undefined off macOS. */
  keychainRunner?: CommandRunner;
  dbtoolDir?: () => string;
}

export class ConnectionManager {
  /** profile id -> a password is stored. Filled lazily (one `security` call per profile) and kept current. */
  private readonly passwordKnown = new Map<string, boolean>();

  constructor(private readonly deps: ManagerDeps) {}

  private withFlag(p: ConnectionProfile): ConnectionProfile {
    return { ...p, hasPassword: this.passwordKnown.get(p.id) ?? false };
  }

  /** Profiles with the cached password flag (synchronous; used by the AI slice). */
  listCached(): ConnectionProfile[] {
    return this.deps.store.list().map((p) => this.withFlag(p));
  }

  getCached(profileId: string): ConnectionProfile | undefined {
    const p = this.deps.store.get(profileId);
    return p ? this.withFlag(p) : undefined;
  }

  async list(): Promise<ConnectionProfile[]> {
    const profiles = this.deps.store.list();
    await Promise.all(
      profiles
        .filter((p) => !this.passwordKnown.has(p.id))
        .map(async (p) => this.passwordKnown.set(p.id, p.kind !== 'sqlite' && (await this.deps.secrets.has(p.id).catch(() => false))))
    );
    return profiles.map((p) => this.withFlag(p));
  }

  private emitChanged(): void {
    this.deps.onChanged?.(this.listCached());
  }

  async save(req: SaveConnectionRequest): Promise<ConnectionProfile> {
    if (!req || typeof req !== 'object' || !req.profile) throw new AppError('Missing connection profile', 'BAD_REQUEST');
    const { saved, previous } = this.deps.store.upsert(req.profile);
    let passwordChanged = false;
    if (req.password === null || req.password === '') {
      await this.deps.secrets.delete(saved.id);
      this.passwordKnown.set(saved.id, false);
      passwordChanged = previous !== undefined;
    } else if (typeof req.password === 'string') {
      await this.deps.secrets.set(saved.id, req.password);
      this.passwordKnown.set(saved.id, true);
      passwordChanged = previous !== undefined;
    }
    if (previous && (passwordChanged || connectionFieldsChanged(previous, saved))) await this.deps.registry.disconnectProfile(saved.id);
    if (!this.passwordKnown.has(saved.id)) this.passwordKnown.set(saved.id, await this.deps.secrets.has(saved.id).catch(() => false));
    this.emitChanged();
    return this.withFlag(saved);
  }

  async delete(profileId: string): Promise<void> {
    await this.deps.registry.disconnectProfile(profileId);
    try {
      await this.deps.secrets.delete(profileId);
    } catch (err) {
      console.error('[connections] could not delete stored password:', err);
    }
    this.passwordKnown.delete(profileId);
    this.deps.store.remove(profileId);
    this.emitChanged();
  }

  /** Open a throwaway connection with the given (possibly unsaved) profile. Never throws for connection errors. */
  async test(req: TestConnectionRequest): Promise<TestConnectionResult> {
    validateProfile(req.profile);
    const profile = normalizeProfile(req.profile);
    if (profile.kind === 'sqlite') {
      // Testing must not create the file as a side effect.
      const path = expandHome(profile.filePath);
      if (path !== ':memory:' && !existsSync(path)) {
        return existsSync(dirname(path))
          ? { ok: true, message: `${path} does not exist yet; it will be created on first connect.` }
          : { ok: false, message: `Folder does not exist: ${dirname(path)}` };
      }
    }
    let password: string | null = null;
    if (profile.kind !== 'sqlite') {
      if (typeof req.password === 'string') password = req.password;
      else if (req.password === undefined && req.profile.id) password = await this.deps.secrets.get(req.profile.id).catch(() => null);
    }
    const timeoutMs = connectTimeoutMs(profile);
    const started = performance.now();
    try {
      const attempt = this.deps.connect(profile, password, profile.database, { readOnly: profile.readOnly, connectTimeoutMs: timeoutMs });
      const driver = await withTimeout(attempt, timeoutMs + 5000, `Timed out after ${Math.round(timeoutMs / 1000)}s`, (late) => void late.close());
      try {
        const serverVersion = await driver.serverVersion();
        const latencyMs = Math.round(performance.now() - started);
        return { ok: true, message: `Connected to ${serverVersion}`, serverVersion, latencyMs };
      } finally {
        await closeQuietly(() => driver.close());
      }
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  async importDbtool(req: ImportDbtoolRequest): Promise<ImportResult> {
    const existing = this.deps.store.list();
    const plan = await planDbtoolImport({
      configDir: (this.deps.dbtoolDir ?? dbtoolConfigDir)(),
      existing,
      includePasswords: req?.includePasswords === true,
      runner: this.deps.keychainRunner
    });
    this.deps.store.addMany(plan.items.map((i) => i.profile));
    let passwordsImported = 0;
    for (const item of plan.items) {
      if (item.password === null) {
        this.passwordKnown.set(item.profile.id, false);
        continue;
      }
      try {
        await this.deps.secrets.set(item.profile.id, item.password);
        this.passwordKnown.set(item.profile.id, true);
        passwordsImported++;
      } catch (err) {
        plan.warnings.push({ name: item.profile.name, message: `Imported without its password: ${errorMessage(err)}` });
      }
    }
    if (plan.items.length > 0) this.emitChanged();
    const result: ImportResult = {
      imported: plan.items.map((i) => this.withFlag(i.profile)),
      skipped: plan.skipped,
      passwordsImported,
      sourcePath: plan.sourcePath
    };
    if (plan.warnings.length > 0) result.warnings = plan.warnings;
    return result;
  }
}
