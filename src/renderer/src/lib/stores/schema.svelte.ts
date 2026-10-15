/**
 * Lazily loaded catalog data (schemas, tables, routines, completion meta),
 * cached per connection + database.
 */
import type { ConnRef, DbMeta, RoutineInfo, SchemaList, TableInfo } from '@shared/types';
import { call, errorMessage } from '$lib/api.svelte';
import { connections } from './connections.svelte';

export interface Loadable<T> {
  status: 'loading' | 'ready' | 'error';
  data?: T;
  error?: string;
}

class SchemaStore {
  schemas = $state<Record<string, Loadable<SchemaList>>>({});
  tables = $state<Record<string, Loadable<TableInfo[]>>>({});
  routines = $state<Record<string, Loadable<RoutineInfo[]>>>({});
  meta = $state<Record<string, Loadable<DbMeta>>>({});
  /** Server database list per profile (for the connection dialog and pickers). */
  databases = $state<Record<string, Loadable<string[]>>>({});

  #key(ref: ConnRef, schema?: string): string {
    const k = connections.refKey(ref);
    return schema === undefined ? k : `${k}|${schema}`;
  }

  async #load<T>(
    store: Record<string, Loadable<T>>,
    key: string,
    force: boolean,
    ref: ConnRef,
    fetch: () => Promise<T>
  ): Promise<T | undefined> {
    const cur = store[key];
    if (!force && cur && (cur.status === 'ready' || cur.status === 'loading')) return cur.data;
    store[key] = { status: 'loading', data: cur?.data };
    if (!(await connections.ensureConnected(ref, { quiet: true }))) {
      store[key] = { status: 'error', error: connections.statusOf(ref)?.error ?? 'Not connected' };
      return undefined;
    }
    try {
      const data = await fetch();
      store[key] = { status: 'ready', data };
      return data;
    } catch (err) {
      store[key] = { status: 'error', error: errorMessage(err) };
      return undefined;
    }
  }

  schemasOf(ref: ConnRef): Loadable<SchemaList> | undefined {
    return this.schemas[this.#key(ref)];
  }
  tablesOf(ref: ConnRef, schema: string): Loadable<TableInfo[]> | undefined {
    return this.tables[this.#key(ref, schema)];
  }
  routinesOf(ref: ConnRef, schema: string): Loadable<RoutineInfo[]> | undefined {
    return this.routines[this.#key(ref, schema)];
  }
  metaOf(ref: ConnRef | null | undefined): Loadable<DbMeta> | undefined {
    return ref ? this.meta[this.#key(ref)] : undefined;
  }

  loadSchemas(ref: ConnRef, force = false) {
    return this.#load(this.schemas, this.#key(ref), force, ref, () => call('db.schemas', { conn: ref }));
  }
  loadTables(ref: ConnRef, schema: string, force = false) {
    return this.#load(this.tables, this.#key(ref, schema), force, ref, () => call('db.tables', { conn: ref, schema }));
  }
  loadRoutines(ref: ConnRef, schema: string, force = false) {
    return this.#load(this.routines, this.#key(ref, schema), force, ref, () =>
      call('db.routines', { conn: ref, schema })
    );
  }
  loadMeta(ref: ConnRef, force = false) {
    return this.#load(this.meta, this.#key(ref), force, ref, () => call('db.meta', { conn: ref }));
  }
  loadDatabases(ref: ConnRef, force = false) {
    return this.#load(this.databases, ref.profileId, force, ref, () => call('db.databases', { conn: ref }));
  }

  /** Drop cached catalog data for a connection (all databases when `database` is omitted on a profile-level refresh). */
  invalidate(ref: ConnRef, wholeProfile = false): void {
    const prefix = wholeProfile ? `${ref.profileId}/` : this.#key(ref);
    for (const store of [this.schemas, this.tables, this.routines, this.meta]) {
      for (const key of Object.keys(store)) {
        if (wholeProfile ? key.startsWith(prefix) : key === prefix || key.startsWith(`${prefix}|`)) delete store[key];
      }
    }
    if (wholeProfile) delete this.databases[ref.profileId];
  }

  /** Every loaded table across connected databases (command palette). */
  allLoadedTables(): { ref: ConnRef; table: TableInfo }[] {
    const out: { ref: ConnRef; table: TableInfo }[] = [];
    const seen = new Set<string>();
    for (const [key, entry] of Object.entries(this.meta)) {
      if (entry.status !== 'ready' || !entry.data) continue;
      const ref = this.#refFromKey(key);
      if (!ref) continue;
      for (const t of entry.data.tables) {
        const id = `${key}|${t.schema}.${t.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ref, table: { schema: t.schema, name: t.name, kind: t.kind } });
      }
    }
    for (const [key, entry] of Object.entries(this.tables)) {
      if (entry.status !== 'ready' || !entry.data) continue;
      const ref = this.#refFromKey(key.split('|')[0]);
      if (!ref) continue;
      for (const t of entry.data) {
        const id = `${key.split('|')[0]}|${t.schema}.${t.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ref, table: t });
      }
    }
    return out;
  }

  #refFromKey(key: string): ConnRef | null {
    const slash = key.indexOf('/');
    if (slash === -1) return null;
    const profileId = key.slice(0, slash);
    const database = key.slice(slash + 1);
    const p = connections.byId(profileId);
    if (!p) return null;
    return p.kind === 'sqlite' ? { profileId } : { profileId, database };
  }
}

export const schema = new SchemaStore();
