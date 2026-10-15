/**
 * Connection profiles and live connection status.
 */
import { toast } from 'svelte-sonner';
import {
  dbKindInfo,
  type ConnRef,
  type ConnectionProfile,
  type ConnectionStatus,
  type DbKind
} from '@shared/types';
import { call, errorMessage, on } from '$lib/api.svelte';

/** Database a ref resolves to ('' for SQLite, which has a single database). */
export function resolveDb(ref: ConnRef, profile: ConnectionProfile | undefined): string {
  if (profile?.kind === 'sqlite') return '';
  return ref.database ?? profile?.database ?? '';
}

export function sameConn(a: ConnRef | null | undefined, b: ConnRef | null | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.profileId !== b.profileId) return false;
  const p = connections.byId(a.profileId);
  return resolveDb(a, p) === resolveDb(b, p);
}

export function blankProfile(kind: DbKind = 'postgres'): ConnectionProfile {
  const info = dbKindInfo(kind);
  const now = new Date().toISOString();
  return {
    id: '',
    name: '',
    kind,
    host: info.fileBased ? '' : 'localhost',
    port: info.defaultPort,
    database: '',
    username: '',
    filePath: '',
    ssl: false,
    trustServerCertificate: false,
    options: {},
    extraDatabases: [],
    color: null,
    group: null,
    production: false,
    readOnly: false,
    hasPassword: false,
    createdAt: now,
    updatedAt: now
  };
}

class ConnectionsStore {
  profiles = $state<ConnectionProfile[]>([]);
  /** Keyed by `refKey`. */
  statuses = $state<Record<string, ConnectionStatus>>({});
  loaded = $state(false);
  /** Last connection the user clicked in the sidebar. */
  selected = $state<ConnRef | null>(null);

  #inflight = new Map<string, Promise<boolean>>();

  readonly groups = $derived.by(() => {
    const map = new Map<string, ConnectionProfile[]>();
    for (const p of [...this.profiles].sort((a, b) => a.name.localeCompare(b.name))) {
      const g = p.group?.trim() || '';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(p);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([name, items]) => ({ name, items }));
  });

  readonly knownGroups = $derived(
    [...new Set(this.profiles.map((p) => p.group?.trim()).filter((g): g is string => !!g))].sort()
  );

  async init(): Promise<void> {
    on('connections.status', (s) => this.#setStatus(s));
    on('connections.changed', (list) => (this.profiles = list));
    try {
      const [list, statuses] = await Promise.all([call('connections.list'), call('connections.statuses')]);
      this.profiles = list;
      for (const s of statuses) this.#setStatus(s);
    } catch (err) {
      toast.error('Could not load connections', { description: errorMessage(err) });
    } finally {
      this.loaded = true;
    }
  }

  byId(id: string | null | undefined): ConnectionProfile | undefined {
    return id ? this.profiles.find((p) => p.id === id) : undefined;
  }

  refKey(ref: ConnRef): string {
    return `${ref.profileId}/${resolveDb(ref, this.byId(ref.profileId))}`;
  }

  /** Databases shown under a profile: the default plus extras (SQLite: a single unnamed one). */
  databasesOf(p: ConnectionProfile): string[] {
    if (p.kind === 'sqlite') return [''];
    return [...new Set([p.database, ...p.extraDatabases].filter((d) => d !== undefined))];
  }

  refsOf(p: ConnectionProfile): ConnRef[] {
    return this.databasesOf(p).map((d) => (p.kind === 'sqlite' ? { profileId: p.id } : { profileId: p.id, database: d }));
  }

  statusOf(ref: ConnRef | null | undefined): ConnectionStatus | undefined {
    return ref ? this.statuses[this.refKey(ref)] : undefined;
  }

  stateOf(ref: ConnRef | null | undefined) {
    return this.statusOf(ref)?.state ?? 'disconnected';
  }

  isConnected(ref: ConnRef | null | undefined): boolean {
    return this.stateOf(ref) === 'connected';
  }

  /** Aggregate state for a profile row: connected if any of its databases is. */
  profileState(p: ConnectionProfile) {
    const states = Object.values(this.statuses)
      .filter((s) => s.profileId === p.id)
      .map((s) => s.state);
    if (states.includes('connected')) return 'connected';
    if (states.includes('connecting')) return 'connecting';
    if (states.includes('error')) return 'error';
    return 'disconnected';
  }

  profileError(p: ConnectionProfile): string | undefined {
    return Object.values(this.statuses).find((s) => s.profileId === p.id && s.state === 'error')?.error;
  }

  /** `Shop (local)` or `Shop (local) · analytics` for non-default databases. */
  label(ref: ConnRef | null | undefined, opts: { alwaysDb?: boolean } = {}): string {
    if (!ref) return 'No connection';
    const p = this.byId(ref.profileId);
    if (!p) return 'Unknown connection';
    const db = resolveDb(ref, p);
    if (!db || (!opts.alwaysDb && db === p.database)) return p.name;
    return `${p.name} · ${db}`;
  }

  #setStatus(s: ConnectionStatus): void {
    const p = this.byId(s.profileId);
    const key = `${s.profileId}/${p?.kind === 'sqlite' ? '' : s.database}`;
    this.statuses[key] = s;
  }

  async connect(ref: ConnRef, opts: { quiet?: boolean } = {}): Promise<boolean> {
    const key = this.refKey(ref);
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const p = this.byId(ref.profileId);
    const promise = (async () => {
      this.statuses[key] = {
        ...(this.statuses[key] ?? { profileId: ref.profileId, database: resolveDb(ref, p) }),
        state: 'connecting',
        error: undefined
      };
      try {
        const status = await call('connections.connect', ref);
        this.#setStatus(status);
        if (status.state === 'error') {
          if (!opts.quiet) toast.error(`Could not connect to ${this.label(ref)}`, { description: status.error });
          return false;
        }
        return status.state === 'connected';
      } catch (err) {
        const message = errorMessage(err);
        this.statuses[key] = { profileId: ref.profileId, database: resolveDb(ref, p), state: 'error', error: message };
        if (!opts.quiet) toast.error(`Could not connect to ${this.label(ref)}`, { description: message });
        return false;
      } finally {
        this.#inflight.delete(key);
      }
    })();
    this.#inflight.set(key, promise);
    return promise;
  }

  async ensureConnected(ref: ConnRef, opts: { quiet?: boolean } = {}): Promise<boolean> {
    if (this.isConnected(ref)) return true;
    return this.connect(ref, opts);
  }

  async disconnect(ref: ConnRef): Promise<void> {
    try {
      const status = await call('connections.disconnect', ref);
      this.#setStatus(status);
    } catch (err) {
      toast.error('Disconnect failed', { description: errorMessage(err) });
    }
  }

  /** Disconnect every open database of a profile. */
  async disconnectProfile(p: ConnectionProfile): Promise<void> {
    const open = Object.values(this.statuses).filter((s) => s.profileId === p.id && s.state !== 'disconnected');
    await Promise.all(
      open.map((s) => this.disconnect(p.kind === 'sqlite' ? { profileId: p.id } : { profileId: p.id, database: s.database }))
    );
  }

  async save(profile: ConnectionProfile, password?: string | null): Promise<ConnectionProfile> {
    const saved = await call('connections.save', { profile, password });
    const idx = this.profiles.findIndex((p) => p.id === saved.id);
    if (idx === -1) this.profiles.push(saved);
    else this.profiles[idx] = saved;
    return saved;
  }

  async remove(p: ConnectionProfile): Promise<void> {
    await this.disconnectProfile(p);
    await call('connections.delete', { profileId: p.id });
    this.profiles = this.profiles.filter((x) => x.id !== p.id);
    for (const key of Object.keys(this.statuses)) if (key.startsWith(`${p.id}/`)) delete this.statuses[key];
    if (this.selected?.profileId === p.id) this.selected = null;
  }

  async duplicate(p: ConnectionProfile): Promise<ConnectionProfile | null> {
    try {
      const copy = await this.save({ ...$state.snapshot(p), id: '', name: `${p.name} copy`, hasPassword: false });
      toast.success(`Duplicated “${p.name}”`, {
        description: p.hasPassword ? 'The stored password was not copied.' : undefined
      });
      return copy;
    } catch (err) {
      toast.error('Duplicate failed', { description: errorMessage(err) });
      return null;
    }
  }
}

export const connections = new ConnectionsStore();
