/**
 * Workspace tabs: query editors, table data, and table structure.
 */
import type { EditorView } from '@codemirror/view';
import { setDiagnostics } from '@codemirror/lint';
import { EditorSelection } from '@codemirror/state';
import { toast } from 'svelte-sonner';
import type { EditorSnapshot } from '@shared/ai';
import { hasSqlContent, isReadOnlyScript, scanParameters, statementAt } from '@shared/sql';
import type { ConnRef, DbKind, QueryError, ResultSet, TableKind } from '@shared/types';
import { call, errorMessage } from '$lib/api.svelte';
import { formatSql } from '$lib/editor/dialect';
import { flashRange } from '$lib/editor/flash';
import { basename, newId } from '$lib/utils';
import { connections, sameConn } from './connections.svelte';
import { dialogs } from './dialogs.svelte';
import { settings } from './settings.svelte';

export type TabKind = 'query' | 'table' | 'structure';

export interface QueryRun {
  sql: string;
  /** Offset of `sql` inside the editor document (for error positions). */
  base: number;
  params?: Record<string, string>;
  conn: ConnRef;
  rowCap?: number;
}

export interface RunSummary {
  durationMs: number;
  rows: number;
  rowsAffected?: number;
  at: number;
  ok: boolean;
  cancelled?: boolean;
}

export class QueryTab {
  readonly kind = 'query' as const;
  readonly id: string;
  customTitle = $state<string | null>(null);
  untitledIndex = $state(1);
  conn = $state<ConnRef | null>(null);
  sql = $state('');
  savedSql = $state('');
  filePath = $state<string | null>(null);
  /** Fraction of the tab height given to the results area. */
  resultsRatio = $state(0.45);
  /** Side panel inside the tab. */
  sidePanel = $state<'history' | 'snippets' | null>(null);

  running = $state(false);
  startedAt = $state(0);
  queryId: string | null = null;
  results = $state.raw<ResultSet[]>([]);
  error = $state.raw<QueryError | null>(null);
  cancelled = $state(false);
  lastRun = $state.raw<RunSummary | null>(null);
  lastRequest = $state.raw<QueryRun | null>(null);
  /** Index into results, or -1 for the Messages tab. */
  activeResult = $state(0);
  /** Bumped after every run; result views reset their local state on change. */
  runSeq = $state(0);

  /** Set by the editor component; not reactive. */
  view: EditorView | null = null;

  constructor(init: { id?: string; sql?: string; conn?: ConnRef | null; title?: string | null; filePath?: string | null }) {
    this.id = init.id ?? newId();
    this.sql = init.sql ?? '';
    this.savedSql = this.sql;
    this.conn = init.conn ?? null;
    this.customTitle = init.title ?? null;
    this.filePath = init.filePath ?? null;
  }

  readonly title = $derived(
    this.customTitle ?? (this.filePath ? basename(this.filePath) : `Query ${this.untitledIndex}`)
  );
  readonly dirty = $derived(this.sql !== this.savedSql && (this.filePath !== null || this.sql.trim() !== ''));
  readonly kindOfDb = $derived<DbKind | null>(connections.byId(this.conn?.profileId)?.kind ?? null);

  // -- editor access ---------------------------------------------------------

  focus(): void {
    this.view?.focus();
  }

  selection(): string | null {
    const v = this.view;
    if (!v) return null;
    const sel = v.state.selection.main;
    return sel.empty ? null : v.state.sliceDoc(sel.from, sel.to);
  }

  snapshot(): EditorSnapshot {
    return { tabId: this.id, title: this.title, sql: this.sql, selection: this.selection(), conn: this.conn };
  }

  replaceSql(sql: string): void {
    const v = this.view;
    if (!v) {
      this.sql = sql;
      return;
    }
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: sql }, selection: { anchor: sql.length } });
    v.focus();
  }

  insertText(text: string): void {
    const v = this.view;
    if (!v) {
      this.sql = this.sql ? `${this.sql}\n${text}` : text;
      return;
    }
    v.dispatch(v.state.replaceSelection(text));
    v.focus();
  }

  /** Select a range in the editor and scroll it into view. */
  reveal(from: number, to = from): void {
    const v = this.view;
    if (!v) return;
    const len = v.state.doc.length;
    const a = Math.min(Math.max(0, from), len);
    const b = Math.min(Math.max(0, to), len);
    v.dispatch({ selection: EditorSelection.single(a, b), scrollIntoView: true });
    v.focus();
  }

  format(): void {
    const v = this.view;
    if (!v) return;
    const sel = v.state.selection.main;
    const from = sel.empty ? 0 : sel.from;
    const to = sel.empty ? v.state.doc.length : sel.to;
    const source = v.state.sliceDoc(from, to);
    if (!source.trim()) return;
    try {
      const formatted = formatSql(source, this.kindOfDb);
      v.dispatch({
        changes: { from, to, insert: formatted },
        selection: sel.empty ? { anchor: Math.min(sel.head, from + formatted.length) } : { anchor: from, head: from + formatted.length }
      });
    } catch (err) {
      toast.error('Could not format SQL', { description: errorMessage(err) });
    }
  }

  // -- execution ---------------------------------------------------------------

  /** Run the selection or the statement at the cursor (`auto`), or the whole script. */
  async run(mode: 'auto' | 'script' = 'auto'): Promise<void> {
    if (this.running) return;
    const v = this.view;
    const doc = v ? v.state.doc.toString() : this.sql;
    let sql = doc;
    let base = 0;
    if (mode === 'auto' && v) {
      const sel = v.state.selection.main;
      if (!sel.empty) {
        sql = v.state.sliceDoc(sel.from, sel.to);
        base = sel.from;
      } else {
        const st = statementAt(doc, sel.head, this.kindOfDb ?? undefined);
        if (!st) {
          toast.info('Nothing to run', { description: 'The editor is empty.' });
          return;
        }
        sql = st.text;
        base = st.start;
        this.#flash(st.start, st.end);
      }
    }
    if (!hasSqlContent(sql)) {
      toast.info('Nothing to run', { description: 'The editor only contains whitespace or comments.' });
      return;
    }
    if (!this.conn) {
      toast.error('Choose a connection first', { description: 'Pick one in the editor toolbar.' });
      return;
    }
    const conn = $state.snapshot(this.conn) as ConnRef;
    const profile = connections.byId(conn.profileId);
    if (!profile) {
      toast.error('This tab’s connection no longer exists');
      return;
    }

    const names = scanParameters(sql);
    let params: Record<string, string> | undefined;
    if (names.length) {
      const values = await dialogs.askParams(names);
      if (!values) return;
      params = values;
    }

    if (settings.value.confirmProductionWrites && profile.production && !isReadOnlyScript(sql, profile.kind)) {
      const ok = await dialogs.confirm({
        title: `Run on production “${connections.label(conn)}”?`,
        message: 'This script can modify data on a production connection.',
        detail: sql.length > 1200 ? `${sql.slice(0, 1200)}…` : sql,
        confirmLabel: 'Run on production',
        danger: true
      });
      if (!ok) return;
    }

    await this.execute({ sql, base, params, conn });
  }

  /** Re-run the last request (e.g. with `rowCap: 0` for "fetch all rows"). */
  async rerun(overrides: Partial<QueryRun> = {}): Promise<void> {
    const last = this.lastRequest;
    if (!last || this.running) return;
    const profile = connections.byId(last.conn.profileId);
    // Never repeat write statements silently (e.g. "Fetch all rows" on a mixed script).
    if (profile && !isReadOnlyScript(last.sql, profile.kind)) {
      const ok = await dialogs.confirm({
        title: profile.production ? `Run again on production “${connections.label(last.conn)}”?` : 'Run the script again?',
        message: 'The last script contains statements that modify data. Running it again repeats those changes.',
        detail: last.sql.length > 1200 ? `${last.sql.slice(0, 1200)}…` : last.sql,
        confirmLabel: 'Run again',
        danger: true
      });
      if (!ok) return;
    }
    await this.execute({ ...last, ...overrides });
  }

  async execute(req: QueryRun): Promise<void> {
    if (!(await connections.ensureConnected(req.conn))) return;
    const queryId = newId();
    this.queryId = queryId;
    this.running = true;
    this.cancelled = false;
    this.startedAt = Date.now();
    this.lastRequest = req;
    this.#clearDiagnostics();
    try {
      const res = await call('db.query', {
        conn: req.conn,
        sql: req.sql,
        queryId,
        rowCap: req.rowCap,
        params: req.params
      });
      if (this.queryId !== queryId) return;
      this.results = res.results;
      this.error = res.error ?? null;
      this.cancelled = !!res.cancelled;
      const withRows = res.results.findIndex((r) => r.columns.length > 0);
      const lastWithRows = res.results.findLastIndex((r) => r.columns.length > 0);
      this.activeResult = res.error || withRows === -1 ? -1 : res.results.length > 1 ? lastWithRows : withRows;
      const last = res.results[res.results.length - 1];
      this.lastRun = {
        durationMs: res.durationMs,
        rows: last?.rows.length ?? 0,
        rowsAffected: last?.rowsAffected,
        at: Date.now(),
        ok: !res.error && !res.cancelled,
        cancelled: res.cancelled
      };
      if (res.error) this.#showErrorMarker(res.error, req);
    } catch (err) {
      if (this.queryId !== queryId) return;
      this.results = [];
      this.error = { message: errorMessage(err) };
      this.activeResult = -1;
      this.lastRun = { durationMs: Date.now() - this.startedAt, rows: 0, at: Date.now(), ok: false };
    } finally {
      if (this.queryId === queryId) {
        this.running = false;
        this.queryId = null;
        this.runSeq++;
        queryEvents.historyVersion++;
      }
    }
  }

  async cancel(): Promise<void> {
    if (!this.running || !this.queryId) return;
    try {
      await call('db.cancel', { queryId: this.queryId });
    } catch (err) {
      toast.error('Cancel failed', { description: errorMessage(err) });
    }
  }

  /** Editor offset of the current error, when the engine reported a position. */
  errorOffset(): number | null {
    const pos = this.error?.position;
    if (pos == null || !this.lastRequest) return null;
    return this.lastRequest.base + pos;
  }

  #showErrorMarker(error: QueryError, req: QueryRun): void {
    const v = this.view;
    if (!v || error.position == null) return;
    const from = Math.min(req.base + error.position, v.state.doc.length);
    const word = /^[\w"`[\].]+/.exec(v.state.sliceDoc(from, Math.min(from + 80, v.state.doc.length)));
    const to = Math.min(from + Math.max(1, word?.[0].length ?? 1), v.state.doc.length);
    v.dispatch(setDiagnostics(v.state, [{ from, to, severity: 'error', message: error.message }]));
  }

  #clearDiagnostics(): void {
    const v = this.view;
    if (v) v.dispatch(setDiagnostics(v.state, []));
  }

  #flash(from: number, to: number): void {
    if (this.view && to > from) flashRange(this.view, from, to);
  }

  serialize(): PersistedQueryTab {
    return {
      kind: 'query',
      id: this.id,
      title: this.customTitle,
      untitledIndex: this.untitledIndex,
      conn: this.conn ? ($state.snapshot(this.conn) as ConnRef) : null,
      sql: this.sql,
      savedSql: this.savedSql,
      filePath: this.filePath,
      resultsRatio: this.resultsRatio
    };
  }
}

export class TableTab {
  readonly kind: 'table' | 'structure';
  readonly id: string;
  conn = $state<ConnRef>({ profileId: '' });
  schema = $state('');
  table = $state('');
  tableKind = $state<TableKind>('table');
  /** Bumped to ask the view to reload. */
  reloadSeq = $state(0);

  constructor(kind: 'table' | 'structure', init: { id?: string; conn: ConnRef; schema: string; table: string; tableKind?: TableKind }) {
    this.kind = kind;
    this.id = init.id ?? newId();
    this.conn = init.conn;
    this.schema = init.schema;
    this.table = init.table;
    this.tableKind = init.tableKind ?? 'table';
  }

  /** Structure tabs are labeled so they can't be mistaken for the table's data tab. */
  get title(): string {
    return this.kind === 'structure' ? `${this.table} (structure)` : this.table;
  }
  readonly dirty = false;

  serialize(): PersistedTableTab {
    return {
      kind: this.kind,
      id: this.id,
      conn: $state.snapshot(this.conn) as ConnRef,
      schema: this.schema,
      table: this.table,
      tableKind: this.tableKind
    };
  }
}

export type Tab = QueryTab | TableTab;

export interface PersistedQueryTab {
  kind: 'query';
  id: string;
  title: string | null;
  untitledIndex: number;
  conn: ConnRef | null;
  sql: string;
  savedSql: string;
  filePath: string | null;
  resultsRatio: number;
}

export interface PersistedTableTab {
  kind: 'table' | 'structure';
  id: string;
  conn: ConnRef;
  schema: string;
  table: string;
  tableKind: TableKind;
}

export type PersistedTab = PersistedQueryTab | PersistedTableTab;

/** Cross-component counters (e.g. refresh the history panel after a run). */
export const queryEvents = $state({ historyVersion: 0 });

export interface OpenQueryOptions {
  sql?: string;
  conn?: ConnRef | null;
  title?: string | null;
  filePath?: string | null;
  run?: boolean;
  /** Insert after the active tab instead of at the end. */
  activate?: boolean;
}

class TabsStore {
  tabs = $state<Tab[]>([]);
  activeId = $state<string | null>(null);
  /** Most-recently-used order of tab ids (for closing). */
  #mru: string[] = [];

  readonly active = $derived(this.tabs.find((t) => t.id === this.activeId) ?? null);
  readonly activeQuery = $derived(this.active?.kind === 'query' ? (this.active as QueryTab) : null);

  /** Connection of the focused tab, or the sidebar selection. */
  activeConn(): ConnRef | null {
    return this.active?.conn ?? connections.selected ?? null;
  }

  activate(id: string): void {
    if (!this.tabs.some((t) => t.id === id)) return;
    this.activeId = id;
    this.#mru = [id, ...this.#mru.filter((x) => x !== id)];
    const tab = this.tabs.find((t) => t.id === id);
    if (tab?.kind === 'query') requestAnimationFrame(() => (tab as QueryTab).focus());
  }

  #nextUntitled(): number {
    const used = new Set(
      this.tabs.filter((t): t is QueryTab => t.kind === 'query' && !t.filePath && !t.customTitle).map((t) => t.untitledIndex)
    );
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  #insert(tab: Tab): void {
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    if (idx === -1) this.tabs.push(tab);
    else this.tabs.splice(idx + 1, 0, tab);
  }

  openQuery(opts: OpenQueryOptions = {}): QueryTab {
    const conn = opts.conn === undefined ? this.activeConn() : opts.conn;
    const tab = new QueryTab({ sql: opts.sql ?? '', conn, title: opts.title ?? null, filePath: opts.filePath ?? null });
    tab.untitledIndex = this.#nextUntitled();
    this.#insert(tab);
    const stored = this.tabs.find((t) => t.id === tab.id) as QueryTab;
    if (opts.activate !== false) this.activate(tab.id);
    if (opts.run && stored.sql.trim()) {
      // Wait for the editor to mount so the run sees the view.
      setTimeout(() => void stored.run('script'), 60);
    }
    return stored;
  }

  #openTableLike(kind: 'table' | 'structure', conn: ConnRef, schemaName: string, table: string, tableKind?: TableKind): TableTab {
    const existing = this.tabs.find(
      (t): t is TableTab =>
        t.kind === kind && sameConn(t.conn, conn) && (t as TableTab).schema === schemaName && (t as TableTab).table === table
    );
    if (existing) {
      this.activate(existing.id);
      return existing;
    }
    const tab = new TableTab(kind, { conn, schema: schemaName, table, tableKind });
    this.#insert(tab);
    this.activate(tab.id);
    return this.tabs.find((t) => t.id === tab.id) as TableTab;
  }

  openTable(conn: ConnRef, schemaName: string, table: string, tableKind?: TableKind): TableTab {
    return this.#openTableLike('table', conn, schemaName, table, tableKind);
  }

  openStructure(conn: ConnRef, schemaName: string, table: string, tableKind?: TableKind): TableTab {
    return this.#openTableLike('structure', conn, schemaName, table, tableKind);
  }

  /** Close a tab, asking first when it has unsaved changes. Resolves false when cancelled. */
  async close(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return true;
    if (!opts.force && tab.kind === 'query' && tab.dirty) {
      this.activate(id);
      const choice = await dialogs.choose({
        title: `Save changes to “${tab.title}”?`,
        message: tab.filePath ? 'Your changes will be lost if you don’t save them.' : 'This query has not been saved to a file.',
        actions: [
          { id: 'save', label: tab.filePath ? 'Save' : 'Save As…', variant: 'primary' },
          { id: 'discard', label: 'Don’t Save', variant: 'danger' },
          { id: 'cancel', label: 'Cancel', variant: 'default' }
        ]
      });
      if (choice === 'save') {
        const saved = await saveQueryTab(tab, false);
        if (!saved) return false;
      } else if (choice !== 'discard') return false;
    }
    if (tab.kind === 'query' && tab.running) void tab.cancel();
    const idx = this.tabs.findIndex((t) => t.id === id);
    this.tabs.splice(idx, 1);
    this.#mru = this.#mru.filter((x) => x !== id);
    if (this.activeId === id) {
      const next = this.#mru.find((x) => this.tabs.some((t) => t.id === x)) ?? this.tabs[Math.min(idx, this.tabs.length - 1)]?.id;
      this.activeId = null;
      if (next) this.activate(next);
    }
    return true;
  }

  async closeOthers(id: string): Promise<void> {
    for (const t of [...this.tabs]) if (t.id !== id && !(await this.close(t.id))) return;
  }

  async closeToRight(id: string): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === id);
    for (const t of this.tabs.slice(idx + 1)) if (!(await this.close(t.id))) return;
  }

  async closeAll(): Promise<void> {
    for (const t of [...this.tabs]) if (!(await this.close(t.id))) return;
  }

  move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
  }

  cycle(dir: 1 | -1): void {
    if (!this.tabs.length) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = (idx + dir + this.tabs.length) % this.tabs.length;
    this.activate(this.tabs[next].id);
  }

  serialize(): { tabs: PersistedTab[]; activeId: string | null } {
    return { tabs: this.tabs.map((t) => t.serialize()), activeId: this.activeId };
  }

  restore(data: { tabs?: PersistedTab[]; activeId?: string | null } | undefined): void {
    if (!data?.tabs?.length) return;
    const restored: Tab[] = [];
    for (const p of data.tabs) {
      try {
        if (p.kind === 'query') {
          const t = new QueryTab({ id: p.id, sql: p.sql, conn: p.conn, title: p.title, filePath: p.filePath });
          t.savedSql = p.savedSql ?? p.sql;
          t.untitledIndex = p.untitledIndex || 1;
          t.resultsRatio = typeof p.resultsRatio === 'number' ? p.resultsRatio : 0.45;
          restored.push(t);
        } else if (p.kind === 'table' || p.kind === 'structure') {
          restored.push(new TableTab(p.kind, p));
        }
      } catch {
        // Skip malformed entries from older sessions.
      }
    }
    this.tabs = restored;
    const active = data.activeId && restored.some((t) => t.id === data.activeId) ? data.activeId : restored[0]?.id;
    if (active) this.activate(active);
  }
}

export const tabs = new TabsStore();

// -- files -------------------------------------------------------------------

const SQL_FILTERS = [
  { name: 'SQL', extensions: ['sql'] },
  { name: 'All Files', extensions: ['*'] }
];

/**
 * Pick one or more .sql files and open each in a query tab. The first file
 * reuses the focused tab when it is an empty untitled query; files that are
 * already open are just focused.
 */
export async function openSqlFiles(): Promise<void> {
  let paths: string[];
  try {
    paths = await call('dialog.openFiles', { title: 'Open SQL Files', filters: SQL_FILTERS });
  } catch (err) {
    toast.error('Could not open file', { description: errorMessage(err) });
    return;
  }
  let first: QueryTab | null = null;
  const failed: string[] = [];
  for (const [i, path] of paths.entries()) {
    try {
      const tab = await openOneSqlFile(path, i === 0);
      first ??= tab;
    } catch (err) {
      failed.push(`${basename(path)}: ${errorMessage(err)}`);
    }
  }
  if (first) tabs.activate(first.id);
  if (failed.length) toast.error(failed.length === 1 ? 'Could not open file' : `Could not open ${failed.length} files`, { description: failed.join('\n') });
}

/** Kept for existing callers (menu, palette). */
export const openSqlFile = openSqlFiles;

async function openOneSqlFile(path: string, mayReuseActive: boolean): Promise<QueryTab> {
  const existing = tabs.tabs.find((t): t is QueryTab => t.kind === 'query' && t.filePath === path);
  if (existing) return existing;
  const file = await call('files.read', { path });
  const active = tabs.activeQuery;
  // Reuse an empty untitled tab instead of adding another one.
  if (mayReuseActive && active && !active.filePath && !active.sql.trim()) {
    active.filePath = file.path;
    active.replaceSql(file.content);
    active.sql = file.content;
    active.savedSql = file.content;
    return active;
  }
  const tab = tabs.openQuery({ sql: file.content, filePath: file.path });
  tab.savedSql = file.content;
  return tab;
}

/** Save a query tab to its file (or ask for one). Resolves false when cancelled or failed. */
export async function saveQueryTab(tab: QueryTab, saveAs: boolean): Promise<boolean> {
  try {
    let path = tab.filePath;
    if (!path || saveAs) {
      const suggested = tab.filePath ?? `${tab.title.replace(/[^\w.-]+/g, '_').toLowerCase()}.sql`;
      path = await call('dialog.saveFile', { title: 'Save SQL File', filters: SQL_FILTERS, defaultPath: suggested });
      if (!path) return false;
    }
    const content = tab.sql;
    await call('files.write', { path, content });
    tab.filePath = path;
    tab.customTitle = null;
    tab.savedSql = content;
    toast.success(`Saved ${basename(path)}`);
    return true;
  } catch (err) {
    toast.error('Could not save file', { description: errorMessage(err) });
    return false;
  }
}
