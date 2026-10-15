/**
 * Flattens connections + lazily loaded catalog data into visible tree rows.
 * Reads reactive stores, so calling it inside `$derived` tracks everything it
 * touches.
 *
 * Levels: [group] -> profile -> database (skipped for SQLite) -> schema
 * (skipped when SQLite has a single schema) -> Tables / Views / Routines -> objects.
 */
import type { ConnRef, ConnectionProfile, RoutineInfo, TableInfo } from '@shared/types';
import { connections } from '$lib/stores/connections.svelte';
import { layout } from '$lib/stores/layout.svelte';
import { schema } from '$lib/stores/schema.svelte';
import { fuzzyScore } from '$lib/utils';

export type FolderKind = 'tables' | 'views' | 'routines';

interface Base {
  key: string;
  depth: number;
  /** Parent row key (for Left-arrow navigation). */
  parent: string | null;
}

export type TreeRow =
  | (Base & { type: 'group'; name: string; expanded: boolean; count: number })
  | (Base & { type: 'profile'; profile: ConnectionProfile; ref: ConnRef; expanded: boolean })
  | (Base & { type: 'database'; profile: ConnectionProfile; ref: ConnRef; name: string; isDefault: boolean; expanded: boolean })
  | (Base & { type: 'schema'; profile: ConnectionProfile; ref: ConnRef; schema: string; isDefault: boolean; expanded: boolean })
  | (Base & {
      type: 'folder';
      profile: ConnectionProfile;
      ref: ConnRef;
      schema: string;
      folder: FolderKind;
      count: number | null;
      expanded: boolean;
    })
  | (Base & { type: 'table'; profile: ConnectionProfile; ref: ConnRef; table: TableInfo })
  | (Base & { type: 'routine'; profile: ConnectionProfile; ref: ConnRef; routine: RoutineInfo })
  | (Base & {
      type: 'status';
      status: 'loading' | 'error' | 'empty' | 'disconnected';
      message: string;
      retry?: () => void;
    });

export type LoadRequest =
  | { kind: 'schemas'; ref: ConnRef }
  | { kind: 'tables'; ref: ConnRef; schema: string }
  | { kind: 'routines'; ref: ConnRef; schema: string };

export const groupKey = (name: string) => `g:${name}`;
export const profileKey = (id: string) => `p:${id}`;
export const dbKey = (id: string, db: string) => `d:${id}/${db}`;
export const schemaKey = (id: string, db: string, s: string) => `s:${id}/${db}/${s}`;
export const folderKey = (id: string, db: string, s: string, f: FolderKind) => `f:${id}/${db}/${s}/${f}`;

const FOLDER_LABEL: Record<FolderKind, string> = { tables: 'Tables', views: 'Views', routines: 'Routines' };
export function folderLabel(f: FolderKind): string {
  return FOLDER_LABEL[f];
}

export function buildTree(filter: string): { rows: TreeRow[]; toLoad: LoadRequest[] } {
  const rows: TreeRow[] = [];
  const toLoad: LoadRequest[] = [];
  const q = filter.trim();
  const matches = (name: string) => !q || fuzzyScore(q, name) >= 0;
  const groups = connections.groups;
  const showGroups = groups.length > 1 || (groups.length === 1 && groups[0].name !== '');

  for (const group of groups) {
    let depth = 0;
    let groupParent: string | null = null;
    // Collapsed groups (default open; stored as an explicit "collapsed" key).
    const gKey = groupKey(group.name);
    const groupOpen = !layout.isExpanded(`${gKey}:collapsed`) || !!q;
    if (showGroups) {
      rows.push({
        type: 'group',
        key: gKey,
        depth: 0,
        parent: null,
        name: group.name || 'Ungrouped',
        expanded: groupOpen,
        count: group.items.length
      });
      if (!groupOpen) continue;
      depth = 1;
      groupParent = gKey;
    }
    for (const p of group.items) addProfile(p, depth, groupParent);
  }
  return { rows, toLoad };

  function addProfile(p: ConnectionProfile, depth: number, parent: string | null): void {
    const key = profileKey(p.id);
    const state = connections.profileState(p);
    const live = state === 'connected' || state === 'connecting';
    const nameMatches = matches(p.name);
    const start = rows.length;
    const ref: ConnRef = p.kind === 'sqlite' ? { profileId: p.id } : { profileId: p.id, database: p.database };
    const expanded = layout.isExpanded(key) && live;
    rows.push({ type: 'profile', key, depth, parent, profile: p, ref, expanded: expanded || (!!q && live) });
    if (!live) {
      if (q && !nameMatches) rows.splice(start);
      return;
    }
    if (!expanded && !q) return;
    const before = rows.length;
    if (p.kind === 'sqlite') addSchemas(p, { profileId: p.id }, '', depth + 1, key, !!q && !nameMatches);
    else {
      for (const db of connections.databasesOf(p)) addDatabase(p, db, depth + 1, key, !!q && !nameMatches);
    }
    // In filter mode, drop profiles with no matching descendants (unless the name itself matches).
    if (q && !nameMatches && rows.length === before) rows.splice(start);
    if (q && nameMatches && !layout.isExpanded(key)) rows.splice(before);
  }

  function addDatabase(p: ConnectionProfile, db: string, depth: number, parent: string, strict: boolean): void {
    const ref: ConnRef = { profileId: p.id, database: db };
    const key = dbKey(p.id, db);
    const st = connections.stateOf(ref);
    const expanded = layout.isExpanded(key) || (!!q && st === 'connected');
    const start = rows.length;
    rows.push({ type: 'database', key, depth, parent, profile: p, ref, name: db, isDefault: db === p.database, expanded });
    if (!expanded) {
      if (strict) rows.splice(start);
      return;
    }
    if (st !== 'connected' && st !== 'connecting') {
      if (q) {
        rows.splice(start);
        return;
      }
      rows.push({
        type: 'status',
        key: `${key}#disc`,
        depth: depth + 1,
        parent: key,
        status: st === 'error' ? 'error' : 'disconnected',
        message: st === 'error' ? (connections.statusOf(ref)?.error ?? 'Connection failed') : 'Not connected',
        retry: () => void connections.connect(ref)
      });
      return;
    }
    const before = rows.length;
    addSchemas(p, ref, db, depth + 1, key, strict);
    if (strict && rows.length === before) rows.splice(start);
  }

  function addSchemas(p: ConnectionProfile, ref: ConnRef, db: string, depth: number, parent: string, strict: boolean): void {
    const entry = schema.schemasOf(ref);
    if (!entry) {
      if (connections.isConnected(ref)) toLoad.push({ kind: 'schemas', ref });
      if (!strict) rows.push(loadingRow(`${parent}#schemas`, depth, parent));
      return;
    }
    if (!entry.data) {
      if (strict) return;
      if (entry.status === 'error')
        rows.push(errorRow(`${parent}#schemas`, depth, parent, entry.error, () => void schema.loadSchemas(ref, true)));
      else rows.push(loadingRow(`${parent}#schemas`, depth, parent));
      return;
    }
    const list = entry.data.schemas;
    if (list.length === 0) {
      if (!strict) rows.push(emptyRow(`${parent}#schemas`, depth, parent, 'No schemas'));
      return;
    }
    // SQLite with only `main`: show folders directly under the profile.
    if (p.kind === 'sqlite' && list.length === 1) {
      addFolders(p, ref, db, list[0], depth, parent, strict);
      return;
    }
    for (const s of list) {
      const key = schemaKey(p.id, db, s);
      const expanded = layout.isExpanded(key) || !!q;
      const start = rows.length;
      rows.push({ type: 'schema', key, depth, parent, profile: p, ref, schema: s, isDefault: s === entry.data.defaultSchema, expanded });
      if (!expanded) continue;
      const before = rows.length;
      addFolders(p, ref, db, s, depth + 1, key, strict || !!q);
      if (q && rows.length === before) rows.splice(start);
    }
  }

  function addFolders(
    p: ConnectionProfile,
    ref: ConnRef,
    db: string,
    s: string,
    depth: number,
    parent: string,
    strict: boolean
  ): void {
    const tables = schema.tablesOf(ref, s);
    const routines = schema.routinesOf(ref, s);
    if (!tables) toLoad.push({ kind: 'tables', ref, schema: s });
    if (!routines) toLoad.push({ kind: 'routines', ref, schema: s });
    if (!tables?.data && !routines?.data) {
      if (strict) return;
      if (tables?.status === 'error')
        rows.push(errorRow(`${parent}#tables`, depth, parent, tables.error, () => void schema.loadTables(ref, s, true)));
      else rows.push(loadingRow(`${parent}#tables`, depth, parent));
      return;
    }
    const baseTables = (tables?.data ?? []).filter((t) => t.kind === 'table');
    const views = (tables?.data ?? []).filter((t) => t.kind !== 'table');
    const folders: [FolderKind, (TableInfo | RoutineInfo)[] | null, boolean][] = [
      ['tables', tables?.data ? baseTables : null, tables?.status === 'loading'],
      ['views', tables?.data ? views : null, tables?.status === 'loading'],
      ['routines', routines?.data ?? null, routines?.status === 'loading' || !routines]
    ];
    for (const [folder, items, loading] of folders) {
      const key = folderKey(p.id, db, s, folder);
      const visible = items ? items.filter((i) => matches(i.name)) : null;
      if (q && (!visible || visible.length === 0)) continue;
      if (!q && folder !== 'tables' && items && items.length === 0) continue;
      // Tables start open; the others start closed.
      const explicit = layout.expanded[key];
      const closedKey = `${key}:collapsed`;
      const expanded = !!q || (folder === 'tables' ? !layout.isExpanded(closedKey) : !!explicit);
      rows.push({ type: 'folder', key, depth, parent, profile: p, ref, schema: s, folder, count: items ? items.length : null, expanded });
      if (!expanded) continue;
      if (!items) {
        if (loading) rows.push(loadingRow(`${key}#loading`, depth + 1, key));
        else if (folder === 'routines' && routines?.status === 'error')
          rows.push(errorRow(`${key}#err`, depth + 1, key, routines.error, () => void schema.loadRoutines(ref, s, true)));
        continue;
      }
      if (items.length === 0) {
        rows.push(emptyRow(`${key}#empty`, depth + 1, key, folder === 'tables' ? 'No tables' : 'None'));
        continue;
      }
      const list = q ? [...(visible ?? [])].sort((a, b) => fuzzyScore(q, b.name) - fuzzyScore(q, a.name)) : items;
      for (const item of list) {
        if (folder === 'routines') {
          const r = item as RoutineInfo;
          rows.push({
            type: 'routine',
            key: `${key}/${r.name}(${r.signature ?? ''})`,
            depth: depth + 1,
            parent: key,
            profile: p,
            ref,
            routine: r
          });
        } else {
          const t = item as TableInfo;
          rows.push({ type: 'table', key: `${key}/${t.name}`, depth: depth + 1, parent: key, profile: p, ref, table: t });
        }
      }
    }
  }
}

function loadingRow(key: string, depth: number, parent: string): TreeRow {
  return { type: 'status', key, depth, parent, status: 'loading', message: 'Loading…' };
}

function errorRow(key: string, depth: number, parent: string, message: string | undefined, retry: () => void): TreeRow {
  return { type: 'status', key, depth, parent, status: 'error', message: message ?? 'Failed to load', retry };
}

function emptyRow(key: string, depth: number, parent: string, message: string): TreeRow {
  return { type: 'status', key, depth, parent, status: 'empty', message };
}
