/**
 * Connection context for a turn: the profile, a connected driver, and a
 * cached catalog for the schema summary in the system prompt.
 */
import type { ConnRef, ConnectionProfile, DbMeta } from '@shared/types';
import type { ConnectionRegistry } from '../services';

const META_TTL_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const META_TIMEOUT_MS = 15_000;
const META_MAX_TABLES = 400;

export interface ConnectionContext {
  profile: ConnectionProfile | null;
  conn: ConnRef | null;
  database: string | null;
  serverVersion: string | null;
  meta: DbMeta | null;
  /** Connection or catalog failure, shown to the model and the user. */
  error: string | null;
}

/** Catalog cache keyed by profile + database, shared across turns and sessions. */
export class MetaCache {
  private entries = new Map<string, { at: number; meta: DbMeta }>();

  constructor(private readonly ttlMs = META_TTL_MS) {}

  static key(profileId: string, database: string): string {
    return `${profileId}\u0000${database}`;
  }

  get(key: string): DbMeta | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return e.meta;
  }

  set(key: string, meta: DbMeta): void {
    this.entries.set(key, { at: Date.now(), meta });
  }

  clear(): void {
    this.entries.clear();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function loadConnectionContext(
  registry: ConnectionRegistry,
  ref: ConnRef | null,
  cache: MetaCache,
  onStatus: (message: string) => void
): Promise<ConnectionContext> {
  const empty: ConnectionContext = { profile: null, conn: null, database: null, serverVersion: null, meta: null, error: null };
  if (!ref) return empty;
  const profile = registry.getProfile(ref.profileId) ?? null;
  if (!profile) return { ...empty, error: 'The selected connection no longer exists.' };

  const ctx: ConnectionContext = { ...empty, profile, conn: ref, database: ref.database ?? null };
  try {
    const status = registry.status(ref);
    if (status.state !== 'connected') onStatus(`Connecting to ${profile.name}…`);
    const driver = await withTimeout(registry.acquire(ref), CONNECT_TIMEOUT_MS, `Connecting to ${profile.name}`);
    ctx.database = driver.database || ctx.database;
    ctx.serverVersion = registry.status(ref).serverVersion ?? null;
    const key = MetaCache.key(profile.id, ctx.database ?? '');
    let meta = cache.get(key);
    if (!meta) {
      onStatus('Reading the database schema…');
      meta = await withTimeout(driver.fetchMeta({ maxTables: META_MAX_TABLES }), META_TIMEOUT_MS, 'Reading the schema');
      cache.set(key, meta);
    }
    ctx.meta = meta;
  } catch (err) {
    ctx.error = err instanceof Error ? err.message : String(err);
  }
  return ctx;
}
