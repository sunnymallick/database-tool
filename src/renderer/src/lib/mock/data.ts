/**
 * OWNER: workbench (UI) slice. Mock handlers for every non-AI method in
 * src/shared/api.ts, backed by realistic in-memory sample data.
 *
 * Profiles, passwords, history, snippets, settings, session, and the mock
 * file system persist in localStorage (keys prefixed `dbt.mock.`). Catalog
 * rows live in memory and reset on reload.
 *
 * Trigger words for exercising the UI from the query editor:
 *  - any SQL containing the bare word `error` (outside string literals) fails
 *    with an engine-style error and a position;
 *  - `pg_sleep(n)`, `WAITFOR DELAY '00:00:05'`, or `SLEEP(n)` waits n seconds
 *    (default 2) and can be cancelled with db.cancel;
 *  - hosts containing `bad`/`invalid`, or the password `wrong`, fail to connect.
 */
import type {
  AppSettings,
  ColumnInfo,
  ConnRef,
  ConnectionProfile,
  ConnectionStatus,
  ForeignKeyInfo,
  HistoryEntry,
  QueryError,
  ResultSet,
  Snippet,
  TableInfo,
  Value
} from '@shared/types';
import { DEFAULT_SETTINGS, dbKindInfo } from '@shared/types';
import { isReadOnlyStatement, quoteIdent, splitStatements, substituteParameters } from '@shared/sql';
import {
  catalogFor,
  colOf,
  databasesFor,
  findTable,
  resolveDatabase,
  rowsOf,
  serverVersion,
  tableDdl,
  type MockDatabase,
  type MockTable
} from './catalog';
import { NUL, vFloat, vInt, vText } from './fixtures';
import {
  SqlError,
  coerceTo,
  compileWhere,
  insertRow,
  latencyFor,
  looseEqual,
  renderPkWhere,
  sortCompare,
  sqlLiteral,
  tableName,
  compareValues,
  execStatement,
  type Env
} from './sqlish';
import { loadJson, newMockId, peekJson, saveJson, sleep } from './store';
import type { MockContext, MockHandlers } from './types';

// ---------------------------------------------------------------------------
// Profiles and passwords
// ---------------------------------------------------------------------------

const SEEDED_AT = '2026-09-02T08:30:00.000Z';

function makeProfile(p: Partial<ConnectionProfile> & Pick<ConnectionProfile, 'id' | 'name' | 'kind'>): ConnectionProfile {
  return {
    host: '',
    port: dbKindInfo(p.kind).defaultPort,
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
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    ...p
  };
}

function seedProfiles(): ConnectionProfile[] {
  return [
    makeProfile({
      id: 'pg-shop',
      name: 'Shop (local)',
      kind: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'shop',
      username: 'postgres',
      extraDatabases: ['shop_staging'],
      color: '#4f8cff',
      group: 'Local',
      hasPassword: true
    }),
    makeProfile({
      id: 'mssql-reporting',
      name: 'Reporting (prod)',
      kind: 'mssql',
      host: 'sql-prod-01.corp.example.com',
      port: 1433,
      database: 'Reporting',
      username: 'report_reader',
      extraDatabases: ['ReportingArchive'],
      color: '#e5484d',
      group: 'Production',
      production: true,
      ssl: true,
      trustServerCertificate: true,
      options: { instanceName: '' },
      hasPassword: true
    }),
    makeProfile({
      id: 'sqlite-sample',
      name: 'Sample (SQLite)',
      kind: 'sqlite',
      port: 0,
      filePath: '/Users/demo/database-tool/tests/fixtures/sample.sqlite',
      color: '#43b883',
      group: 'Local'
    }),
    makeProfile({
      id: 'mysql-analytics',
      name: 'Analytics (MySQL)',
      kind: 'mysql',
      host: '10.0.4.12',
      port: 3306,
      database: 'analytics',
      username: 'analyst',
      readOnly: true,
      color: '#e9b44c',
      hasPassword: true
    })
  ];
}

let profilesCache: ConnectionProfile[] | null = null;
const profiles = (): ConnectionProfile[] => (profilesCache ??= loadJson('profiles', seedProfiles));
function saveProfiles(list: ConnectionProfile[], ctx: MockContext): void {
  profilesCache = list;
  saveJson('profiles', list);
  ctx.emit('connections.changed', list);
}

function getProfile(id: string): ConnectionProfile {
  const p = profiles().find((x) => x.id === id);
  if (!p) throw new Error(`Unknown connection profile: ${id}`);
  return p;
}

const passwords = (): Record<string, string> =>
  loadJson('passwords', () => ({ 'pg-shop': 'postgres', 'mssql-reporting': 'R3port!ng', 'mysql-analytics': 'analyst' }));

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

const statusKey = (profileId: string, database: string) => `${profileId}::${database}`;
const statuses = new Map<string, ConnectionStatus>([
  [
    statusKey('pg-shop', 'shop'),
    { profileId: 'pg-shop', database: 'shop', state: 'connected', serverVersion: serverVersion('postgres'), connectedAt: new Date().toISOString() }
  ]
]);
const connecting = new Map<string, Promise<ConnectionStatus>>();

function setStatus(st: ConnectionStatus, ctx: MockContext): ConnectionStatus {
  statuses.set(statusKey(st.profileId, st.database), st);
  ctx.emit('connections.status', st);
  return st;
}

function connectFailure(p: ConnectionProfile, database: string, password?: string | null): string | null {
  if (p.kind === 'sqlite') return p.filePath.trim() ? null : 'SQLITE_CANTOPEN: unable to open database file (no file selected)';
  if (/bad|invalid/i.test(p.host)) return `getaddrinfo ENOTFOUND ${p.host}`;
  if (!p.host.trim()) return 'connect ECONNREFUSED 127.0.0.1:' + p.port;
  const pw = password === undefined ? passwords()[p.id] : password;
  if (pw === 'wrong') {
    switch (p.kind) {
      case 'mssql':
        return `Login failed for user '${p.username}'.`;
      case 'mysql':
        return `Access denied for user '${p.username}'@'10.0.4.77' (using password: YES)`;
      default:
        return `password authentication failed for user "${p.username}"`;
    }
  }
  if (database && !databasesFor(p).includes(database)) {
    return p.kind === 'mssql' ? `Cannot open database "${database}" requested by the login. The login failed.` : p.kind === 'mysql' ? `Unknown database '${database}'` : `database "${database}" does not exist`;
  }
  return null;
}

async function connect(ref: ConnRef, ctx: MockContext): Promise<ConnectionStatus> {
  const p = getProfile(ref.profileId);
  const database = resolveDatabase(p, ref.database);
  const key = statusKey(p.id, database);
  const existing = statuses.get(key);
  if (existing?.state === 'connected') return existing;
  const inflight = connecting.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    setStatus({ profileId: p.id, database, state: 'connecting' }, ctx);
    await sleep(300 + Math.random() * 400);
    const failure = connectFailure(p, database);
    if (failure) {
      setStatus({ profileId: p.id, database, state: 'error', error: failure }, ctx);
      throw new Error(failure);
    }
    return setStatus({ profileId: p.id, database, state: 'connected', serverVersion: serverVersion(p.kind), connectedAt: new Date().toISOString() }, ctx);
  })();
  connecting.set(key, promise);
  try {
    return await promise;
  } finally {
    connecting.delete(key);
  }
}

interface Target {
  profile: ConnectionProfile;
  db: MockDatabase;
  env: Env;
}

async function target(ref: ConnRef, ctx: MockContext): Promise<Target> {
  const profile = getProfile(ref.profileId);
  await connect(ref, ctx);
  const db = catalogFor(profile, ref.database);
  const env: Env = {
    db,
    kind: profile.kind,
    database: resolveDatabase(profile, ref.database),
    user: profile.username || (profile.kind === 'sqlite' ? 'main' : 'postgres'),
    version: serverVersion(profile.kind)
  };
  return { profile, db, env };
}

function tableOrThrow(db: MockDatabase, schema: string, name: string): MockTable {
  const t = findTable(db, schema, name);
  if (!t) {
    if (!db.schemas.some((s) => s.toLowerCase() === schema.toLowerCase())) throw new Error(`schema "${schema}" does not exist`);
    throw new Error(`relation "${schema}.${name}" does not exist`);
  }
  return t;
}

function schemaOrThrow(db: MockDatabase, schema: string): string {
  const s = db.schemas.find((x) => x === schema) ?? db.schemas.find((x) => x.toLowerCase() === schema.toLowerCase());
  if (!s) throw new Error(`schema "${schema}" does not exist`);
  return s;
}

// ---------------------------------------------------------------------------
// Settings, history, snippets
// ---------------------------------------------------------------------------

const settings = (): AppSettings => ({ ...DEFAULT_SETTINGS, ...loadJson<Partial<AppSettings>>('settings', () => ({})) });

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function seedHistory(): HistoryEntry[] {
  const e = (m: number, profileId: string, connectionName: string, database: string | undefined, sql: string, durationMs: number, rowCount?: number, error?: string): HistoryEntry => ({
    id: newMockId(),
    ts: minutesAgo(m),
    profileId,
    ...(database ? { database } : {}),
    connectionName,
    sql,
    durationMs,
    ...(rowCount !== undefined ? { rowCount } : {}),
    ...(error ? { error } : {})
  });
  return [
    e(4, 'pg-shop', 'Shop (local)', 'shop', "SELECT id, email, full_name, country\nFROM customers\nWHERE country = 'DE'\nORDER BY created_at DESC\nLIMIT 50;", 38, 21),
    e(11, 'pg-shop', 'Shop (local)', 'shop', 'SELECT status, count(*) AS orders, sum(total) AS revenue\nFROM sales.orders\nGROUP BY status\nORDER BY revenue DESC;', 61, 5),
    e(19, 'pg-shop', 'Shop (local)', 'shop', 'SELECT * FROM sales.order_itemz LIMIT 100;', 12, undefined, 'relation "sales.order_itemz" does not exist'),
    e(47, 'mssql-reporting', 'Reporting (prod)', 'Reporting', 'SELECT TOP 100 * FROM dbo.Orders ORDER BY PlacedAt DESC;', 212, 100),
    e(95, 'mssql-reporting', 'Reporting (prod)', 'Reporting', 'SELECT * FROM dbo.vw_MonthlyRevenue ORDER BY [Month];', 148, 21),
    e(180, 'sqlite-sample', 'Sample (SQLite)', 'main', 'SELECT * FROM customer_order_totals ORDER BY lifetime_value DESC LIMIT 20;', 9, 20),
    e(260, 'mysql-analytics', 'Analytics (MySQL)', 'analytics', 'SELECT device, COUNT(*) AS sessions FROM sessions GROUP BY device;', 77, 3),
    e(1440, 'pg-shop', 'Shop (local)', 'shop', "UPDATE public.products SET stock = stock + 25 WHERE sku = 'SKU-1007';", 22, 1)
  ];
}

let historyCache: HistoryEntry[] | null = null;
const history = (): HistoryEntry[] => (historyCache ??= loadJson('history', seedHistory));

function recordHistory(entry: Omit<HistoryEntry, 'id' | 'ts'>): void {
  const list = history();
  list.unshift({ id: newMockId(), ts: new Date().toISOString(), ...entry });
  if (list.length > 500) list.length = 500;
  saveJson('history', list);
}

function seedSnippets(): Snippet[] {
  return [
    {
      id: newMockId(),
      name: 'Top customers by revenue',
      description: 'Lifetime value of non-cancelled orders',
      sql: "SELECT c.id, c.full_name, c.country, sum(o.total) AS revenue\nFROM public.customers c\nJOIN sales.orders o ON o.customer_id = c.id\nWHERE o.status <> 'cancelled'\nGROUP BY c.id, c.full_name, c.country\nORDER BY revenue DESC\nLIMIT :limit;",
      updatedAt: minutesAgo(60 * 24 * 3)
    },
    {
      id: newMockId(),
      name: 'Orders per day',
      sql: "SELECT date_trunc('day', placed_at)::date AS day, count(*) AS orders\nFROM sales.orders\nWHERE placed_at >= :since\nGROUP BY 1\nORDER BY 1;",
      updatedAt: minutesAgo(60 * 24 * 9)
    },
    {
      id: newMockId(),
      name: 'Find duplicates by email',
      description: 'Case-insensitive duplicate check',
      sql: 'SELECT lower(email) AS email, count(*) AS copies\nFROM customers\nGROUP BY lower(email)\nHAVING count(*) > 1;',
      updatedAt: minutesAgo(60 * 24 * 30)
    }
  ];
}

let snippetsCache: Snippet[] | null = null;
const snippets = (): Snippet[] => (snippetsCache ??= loadJson('snippets', seedSnippets));

// ---------------------------------------------------------------------------
// Mock file system
// ---------------------------------------------------------------------------

function seedFiles(): Record<string, string> {
  return {
    '/Users/demo/queries/top_customers.sql':
      "-- Top customers by lifetime value\nSELECT c.id, c.full_name, c.country, sum(o.total) AS lifetime_value\nFROM public.customers c\nJOIN sales.orders o ON o.customer_id = c.id\nWHERE o.status <> 'cancelled'\nGROUP BY c.id, c.full_name, c.country\nORDER BY lifetime_value DESC\nLIMIT 25;\n",
    '/Users/demo/queries/monthly_revenue.sql':
      "-- Revenue per month (excludes cancelled orders)\nSELECT date_trunc('month', placed_at)::date AS month,\n       count(*) AS orders,\n       sum(total) AS revenue\nFROM sales.orders\nWHERE status <> 'cancelled'\nGROUP BY 1\nORDER BY 1;\n"
  };
}

const files = (): Record<string, string> => loadJson('files', seedFiles);

// ---------------------------------------------------------------------------
// Query execution helpers
// ---------------------------------------------------------------------------

const running = new Map<string, AbortController>();

/** Resolves true after `ms`, or false as soon as the signal aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sleepSeconds(sql: string): number | null {
  const pg = /\bpg_sleep\s*\(\s*([\d.]+)?\s*\)/i.exec(sql);
  if (pg) return pg[1] ? Number(pg[1]) : 2;
  const wait = /\bWAITFOR\s+DELAY\s+'(\d+):(\d+):(\d+(?:\.\d+)?)'/i.exec(sql);
  if (wait) return Number(wait[1]) * 3600 + Number(wait[2]) * 60 + Number(wait[3]);
  const my = /\bSLEEP\s*\(\s*([\d.]+)?\s*\)/i.exec(sql);
  if (my) return my[1] ? Number(my[1]) : 2;
  return null;
}

function maskLiteralsAndComments(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

function errorWordFailure(text: string, env: Env): Omit<QueryError, 'statementIndex'> | null {
  const masked = maskLiteralsAndComments(text);
  const m = /(?<![\w$])["`[]?error["`\]]?(?![\w$])/i.exec(masked);
  if (!m) return null;
  const wordAt = m.index + (/^["`[]/.test(m[0]) ? 1 : 0);
  const asRelation = /\b(FROM|JOIN|INTO|UPDATE|TABLE)\s*$/i.test(masked.slice(0, m.index));
  const word = text.substr(wordAt, 5);
  switch (env.kind) {
    case 'mssql':
      return asRelation ? { message: `Invalid object name '${word}'.`, code: '208', position: wordAt } : { message: `Invalid column name '${word}'.`, code: '207', position: wordAt };
    case 'mysql':
      return asRelation
        ? { message: `Table '${env.database}.${word}' doesn't exist`, code: '1146', position: wordAt }
        : { message: `Unknown column '${word}' in 'field list'`, code: '1054', position: wordAt };
    case 'sqlite':
      return asRelation ? { message: `no such table: ${word}`, code: 'SQLITE_ERROR', position: wordAt } : { message: `no such column: ${word}`, code: 'SQLITE_ERROR', position: wordAt };
    default:
      return asRelation
        ? { message: `relation "${word}" does not exist`, code: '42P01', position: wordAt }
        : { message: `column "${word}" does not exist`, code: '42703', position: wordAt, hint: 'Perhaps you meant to reference a different column.' };
  }
}

function sleepResult(env: Env, secs: number, statement: string, statementIndex: number, durationMs: number): ResultSet {
  const col = env.kind === 'postgres' ? { name: 'pg_sleep', type: 'void' } : env.kind === 'mysql' ? { name: `SLEEP(${secs})`, type: 'bigint' } : { name: 'waited_seconds', type: 'int' };
  const value: Value = env.kind === 'postgres' ? vText('') : env.kind === 'mysql' ? vInt(0) : vFloat(secs);
  return { columns: [col], rows: [[value]], truncated: false, statement, statementIndex, durationMs };
}

function toQueryError(err: unknown, statementIndex: number, offset: number): QueryError {
  if (err instanceof SqlError) {
    return {
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
      statementIndex,
      ...(err.pos !== undefined ? { position: offset + err.pos } : {}),
      ...(err.hint ? { hint: err.hint } : {})
    };
  }
  return { message: err instanceof Error ? err.message : String(err), statementIndex };
}

function asError(err: unknown): Error {
  if (err instanceof SqlError) return new Error(err.hint ? `${err.message}\nHINT: ${err.hint}` : err.message);
  return err instanceof Error ? err : new Error(String(err));
}

function selectSql(env: Env, t: MockTable, where: string | undefined, orderBy: { column: string; desc: boolean }[] | undefined, limit: number, offset: number): string {
  const k = env.kind;
  const name = tableName(k, t);
  const order = orderBy?.length ? ` ORDER BY ${orderBy.map((o) => `${quoteIdent(k, o.column)}${o.desc ? ' DESC' : ''}`).join(', ')}` : '';
  const filter = where?.trim() ? ` WHERE ${where.trim()}` : '';
  if (k === 'mssql') {
    const ord = order || ` ORDER BY ${t.primaryKey.length ? t.primaryKey.map((c) => quoteIdent(k, c)).join(', ') : '(SELECT NULL)'}`;
    return `SELECT * FROM ${name}${filter}${ord} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  return `SELECT * FROM ${name}${filter}${order} LIMIT ${limit} OFFSET ${offset}`;
}

function referencedBy(db: MockDatabase, t: MockTable): ForeignKeyInfo[] {
  const out: ForeignKeyInfo[] = [];
  for (const other of db.tables)
    for (const fk of other.foreignKeys) if (fk.refSchema === t.schema && fk.refTable === t.name) out.push({ ...fk, columns: [...fk.columns], refColumns: [...fk.refColumns] });
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const dataMock: MockHandlers = {
  // -- app / files ----------------------------------------------------------
  'app.info': () => ({
    name: 'Database Tool',
    version: '0.1.0',
    electron: '44.7.0',
    node: '22.20.0',
    chrome: '144.0.7559.60',
    platform: 'darwin',
    dataDir: '~/Library/Application Support/database-tool'
  }),
  'dialog.openFile': async (req) => {
    await sleep(150);
    const exts = (req.filters ?? []).flatMap((f) => f.extensions.map((e) => e.toLowerCase()));
    if (exts.some((e) => ['sqlite', 'sqlite3', 'db', 'db3'].includes(e))) return '/Users/demo/data/inventory.sqlite';
    return '/Users/demo/queries/top_customers.sql';
  },
  'dialog.saveFile': async (req) => {
    await sleep(150);
    const d = req.defaultPath?.trim();
    if (d && d.startsWith('/')) return d;
    return `/Users/demo/queries/${d || 'untitled.sql'}`;
  },
  'dialog.openFiles': async (req) => {
    await sleep(150);
    const exts = (req.filters ?? []).flatMap((f) => f.extensions.map((e) => e.toLowerCase()));
    if (exts.some((e) => ['sqlite', 'sqlite3', 'db', 'db3'].includes(e))) return ['/Users/demo/data/inventory.sqlite'];
    return ['/Users/demo/queries/top_customers.sql'];
  },
  'dialog.openDirectory': async () => {
    await sleep(150);
    return '/Users/demo/exports';
  },
  'files.writeBytes': (req) => {
    console.info(`[mock] wrote ${req.data.byteLength} bytes to ${req.path}`);
  },
  'files.writeToDirectory': (req) => {
    const all = files();
    const paths = req.files.map((f) => {
      const path = `${req.dir}/${f.name}`;
      if (typeof f.content === 'string') all[path] = f.content;
      return path;
    });
    saveJson('files', all);
    return { paths };
  },
  'files.read': (req) => {
    const all = files();
    if (!(req.path in all)) throw new Error(`ENOENT: no such file or directory, open '${req.path}'`);
    return { path: req.path, content: all[req.path] };
  },
  'files.write': (req) => {
    const all = files();
    all[req.path] = req.content;
    saveJson('files', all);
  },
  'shell.showItemInFolder': () => undefined,
  'shell.openExternal': (req) => {
    if (typeof window !== 'undefined' && /^https?:\/\//i.test(req.url)) window.open(req.url, '_blank', 'noopener');
  },

  // -- connections -------------------------------------------------------------
  'connections.list': () => profiles(),
  'connections.save': (req, ctx) => {
    const incoming = req.profile;
    if (!incoming.name?.trim()) throw new Error('Connection name is required');
    const list = [...profiles()];
    const idx = incoming.id ? list.findIndex((p) => p.id === incoming.id) : -1;
    const prev = idx >= 0 ? list[idx] : null;
    const now = new Date().toISOString();
    const saved: ConnectionProfile = {
      ...incoming,
      id: prev?.id ?? (incoming.id || newMockId()),
      name: incoming.name.trim(),
      options: { ...(incoming.options ?? {}) },
      extraDatabases: [...(incoming.extraDatabases ?? [])].filter((d) => d.trim() !== ''),
      hasPassword: req.password === undefined ? (prev?.hasPassword ?? false) : typeof req.password === 'string',
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    };
    const pw = { ...passwords() };
    if (typeof req.password === 'string') pw[saved.id] = req.password;
    else if (req.password === null) delete pw[saved.id];
    saveJson('passwords', pw);
    if (idx >= 0) list[idx] = saved;
    else list.push(saved);
    saveProfiles(list, ctx);
    return saved;
  },
  'connections.delete': (req, ctx) => {
    const list = profiles().filter((p) => p.id !== req.profileId);
    for (const [key, st] of [...statuses]) {
      if (st.profileId !== req.profileId) continue;
      statuses.delete(key);
      ctx.emit('connections.status', { profileId: st.profileId, database: st.database, state: 'disconnected' });
    }
    const pw = { ...passwords() };
    delete pw[req.profileId];
    saveJson('passwords', pw);
    saveProfiles(list, ctx);
  },
  'connections.test': async (req) => {
    const started = performance.now();
    await sleep(450 + Math.random() * 250);
    const p = req.profile;
    const password = req.password === undefined ? (p.id ? passwords()[p.id] : undefined) : req.password;
    const failure = connectFailure(p, p.kind === 'sqlite' ? 'main' : p.database || '', password ?? null);
    if (failure) return { ok: false, message: failure };
    const version = serverVersion(p.kind);
    return { ok: true, message: `Connected to ${version}`, serverVersion: version, latencyMs: Math.max(1, Math.round((performance.now() - started) / 40)) };
  },
  'connections.connect': (req, ctx) => connect(req, ctx),
  'connections.disconnect': async (req, ctx) => {
    const p = getProfile(req.profileId);
    const database = resolveDatabase(p, req.database);
    await sleep(80);
    return setStatus({ profileId: p.id, database, state: 'disconnected' }, ctx);
  },
  'connections.statuses': () => [...statuses.values()].filter((s) => s.state !== 'disconnected'),
  'connections.importDbtool': async (req, ctx) => {
    await sleep(req.includePasswords ? 900 : 400);
    const sourcePath = '~/Library/Application Support/dbTool/connections.json';
    if (peekJson<boolean>('dbtoolImported')) {
      return {
        imported: [],
        skipped: [
          { name: 'record-shop — dev', reason: 'already imported' },
          { name: 'Legacy CRM', reason: 'already imported' }
        ],
        passwordsImported: 0,
        sourcePath
      };
    }
    const now = new Date().toISOString();
    const imported: ConnectionProfile[] = [
      makeProfile({
        id: newMockId(),
        name: 'record-shop — dev',
        kind: 'sqlite',
        port: 0,
        filePath: '/tmp/demo/record_shop.db',
        color: '#c792ea',
        group: 'Imported',
        createdAt: now,
        updatedAt: now
      }),
      makeProfile({
        id: newMockId(),
        name: 'Legacy CRM',
        kind: 'mssql',
        host: 'crm-sql.corp.example.com',
        port: 1433,
        database: 'CRM',
        username: 'crm_app',
        ssl: true,
        trustServerCertificate: true,
        options: { instanceName: 'LEGACY' },
        color: '#7fd4e8',
        group: 'Imported',
        hasPassword: req.includePasswords,
        createdAt: now,
        updatedAt: now
      })
    ];
    saveJson('dbtoolImported', true);
    if (req.includePasswords) saveJson('passwords', { ...passwords(), [imported[1].id]: 'crm-secret' });
    saveProfiles([...profiles(), ...imported], ctx);
    return {
      imported,
      skipped: [{ name: 'old-tunnel', reason: 'SSH tunnels are not supported yet' }],
      passwordsImported: req.includePasswords ? 1 : 0,
      sourcePath
    };
  },

  // -- database browsing ---------------------------------------------------------
  'db.databases': async (req, ctx) => {
    const { profile } = await target(req.conn, ctx);
    return databasesFor(profile);
  },
  'db.schemas': async (req, ctx) => {
    const { db } = await target(req.conn, ctx);
    return { schemas: [...db.schemas], defaultSchema: db.defaultSchema };
  },
  'db.tables': async (req, ctx) => {
    const { db } = await target(req.conn, ctx);
    const schema = schemaOrThrow(db, req.schema);
    return db.tables
      .filter((t) => t.schema === schema)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t): TableInfo => ({
        schema: t.schema,
        name: t.name,
        kind: t.kind,
        ...(t.comment ? { comment: t.comment } : {}),
        ...(t.kind !== 'view' ? { rowEstimate: rowsOf(db, t).length } : {})
      }));
  },
  'db.routines': async (req, ctx) => {
    const { db } = await target(req.conn, ctx);
    const schema = schemaOrThrow(db, req.schema);
    return db.routines
      .filter((r) => r.schema === schema)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ body: _body, ...info }) => info);
  },
  'db.structure': async (req, ctx) => {
    const { db } = await target(req.conn, ctx);
    const t = tableOrThrow(db, req.schema, req.table);
    const columns = t.columns.map(
      (c, i): ColumnInfo => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        defaultValue: c.defaultValue,
        isPrimaryKey: t.primaryKey.includes(c.name),
        isIdentity: c.isIdentity,
        ...(c.isGenerated ? { isGenerated: true } : {}),
        ...(c.comment ? { comment: c.comment } : {}),
        ordinal: i + 1
      })
    );
    return {
      schema: t.schema,
      name: t.name,
      kind: t.kind,
      columns,
      primaryKey: [...t.primaryKey],
      indexes: t.indexes.map((i) => ({ ...i, columns: [...i.columns] })),
      foreignKeys: t.foreignKeys.map((f) => ({ ...f, columns: [...f.columns], refColumns: [...f.refColumns] })),
      referencedBy: referencedBy(db, t),
      checks: t.checks.map((c) => ({ ...c })),
      ...(t.comment ? { comment: t.comment } : {}),
      ...(t.kind !== 'view' ? { rowEstimate: rowsOf(db, t).length } : {})
    };
  },
  'db.ddl': async (req, ctx) => {
    const { db } = await target(req.conn, ctx);
    return tableDdl(db, tableOrThrow(db, req.schema, req.table));
  },
  'db.routineDefinition': async (req, ctx) => {
    const { db } = await target(req.conn, ctx);
    const r = db.routines.find((x) => x.schema.toLowerCase() === req.schema.toLowerCase() && x.name.toLowerCase() === req.name.toLowerCase() && x.kind === req.kind);
    if (!r) throw new Error(`${req.kind} ${req.schema}.${req.name} does not exist`);
    return r.body;
  },
  'db.meta': async (req, ctx) => {
    const { db } = await target(req.conn, ctx);
    return {
      defaultSchema: db.defaultSchema,
      schemas: [...db.schemas],
      tables: db.tables.map((t) => ({ schema: t.schema, name: t.name, kind: t.kind, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) }))
    };
  },

  // -- queries -----------------------------------------------------------------
  'db.query': async (req, ctx) => {
    const started = performance.now();
    const { profile, env } = await target(req.conn, ctx);
    const controller = new AbortController();
    running.set(req.queryId, controller);
    const sql = req.params && Object.keys(req.params).length ? substituteParameters(req.sql, req.params, profile.kind) : req.sql;
    const cap = req.rowCap ?? settings().rowCap;
    const results: ResultSet[] = [];
    let error: QueryError | undefined;
    let cancelled = false;
    try {
      const stmts = splitStatements(sql, profile.kind);
      for (const [index, st] of stmts.entries()) {
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }
        const failure = errorWordFailure(st.text, env);
        if (failure) {
          if (!(await abortableSleep(40, controller.signal))) cancelled = true;
          else error = { ...failure, statementIndex: index, ...(failure.position !== undefined ? { position: st.start + failure.position } : {}) };
          break;
        }
        if (profile.readOnly && !isReadOnlyStatement(st.text)) {
          error = { message: `Connection "${profile.name}" is read-only: write statements are blocked`, code: 'READ_ONLY', statementIndex: index };
          break;
        }
        const secs = sleepSeconds(st.text);
        if (secs !== null) {
          const t0 = performance.now();
          if (!(await abortableSleep(Math.min(secs, 600) * 1000, controller.signal))) {
            cancelled = true;
            break;
          }
          results.push(sleepResult(env, secs, st.text, index, Math.round(performance.now() - t0)));
          continue;
        }
        let outcome;
        try {
          outcome = execStatement(st.text, env);
        } catch (err) {
          error = toQueryError(err, index, st.start);
          break;
        }
        const truncated = cap > 0 && outcome.rows.length > cap;
        const rows = truncated ? outcome.rows.slice(0, cap) : outcome.rows;
        const latency = latencyFor(st.text, rows.length);
        if (!(await abortableSleep(Math.min(latency, 900), controller.signal))) {
          cancelled = true;
          break;
        }
        const messages = outcome.messages?.length ? outcome.messages : undefined;
        results.push({
          columns: outcome.columns,
          rows,
          truncated,
          statement: st.text,
          statementIndex: index,
          durationMs: latency,
          ...(outcome.rowsAffected !== undefined ? { rowsAffected: outcome.rowsAffected } : {}),
          ...(outcome.editable ? { editable: outcome.editable } : {}),
          ...(messages ? { messages } : {})
        });
      }
    } finally {
      running.delete(req.queryId);
    }
    const durationMs = Math.round(performance.now() - started);
    const last = results[results.length - 1];
    recordHistory({
      profileId: profile.id,
      database: env.database,
      connectionName: profile.name,
      sql: req.sql,
      durationMs,
      ...(last ? { rowCount: last.columns.length ? last.rows.length : (last.rowsAffected ?? 0) } : {}),
      ...(error ? { error: error.message } : cancelled ? { error: 'canceling statement due to user request' } : {})
    });
    return { results, durationMs, ...(error ? { error } : {}), ...(cancelled ? { cancelled: true } : {}) };
  },
  'db.cancel': (req) => {
    running.get(req.queryId)?.abort();
  },
  'db.rows': async (req, ctx) => {
    const started = performance.now();
    const { db, env } = await target(req.table.conn, ctx);
    const t = tableOrThrow(db, req.table.schema, req.table.table);
    const cols = t.columns.map((c) => ({ name: c.name, type: c.type }));
    let rows = rowsOf(db, t);
    if (req.where?.trim()) {
      try {
        rows = rows.filter(compileWhere(req.where, cols, env));
      } catch (err) {
        throw asError(err);
      }
    }
    if (req.orderBy?.length) {
      const keys = req.orderBy.map((o) => {
        const i = t.columns.findIndex((c) => c.name === o.column);
        if (i < 0) throw new Error(`column "${o.column}" does not exist`);
        return { i, desc: o.desc };
      });
      rows = [...rows].sort((a, b) => {
        for (const { i, desc } of keys) {
          const x = a[i];
          const y = b[i];
          if (x.t === 'null' || y.t === 'null') {
            const c = sortCompare(x, y);
            if (c) return c;
            continue;
          }
          const c = compareValues(x, y) ?? 0;
          if (c) return desc ? -c : c;
        }
        return 0;
      });
    }
    const limit = Math.max(0, req.limit);
    const offset = Math.max(0, req.offset);
    const page = rows.slice(offset, offset + limit);
    const latency = latencyFor(`${t.name}:${req.where ?? ''}:${offset}`, page.length);
    await sleep(Math.min(latency, 500));
    const editable = t.kind === 'table' && t.primaryKey.length > 0 ? { schema: t.schema, table: t.name, primaryKey: [...t.primaryKey] } : undefined;
    return {
      result: {
        columns: cols,
        rows: page,
        truncated: false,
        statement: selectSql(env, t, req.where, req.orderBy, limit, offset),
        statementIndex: 0,
        durationMs: Math.round(performance.now() - started),
        ...(editable ? { editable } : {})
      },
      total: req.countTotal ? rows.length : null,
      primaryKey: [...t.primaryKey]
    };
  },
  'db.applyChanges': async (req, ctx) => {
    const { profile, db } = await target(req.table.conn, ctx);
    const t = tableOrThrow(db, req.table.schema, req.table.table);
    const k = profile.kind;
    const { updates, inserts, deletes } = req.changes;
    if (t.kind !== 'table') throw new Error(`cannot change ${t.kind === 'view' ? 'view' : 'materialized view'} "${t.name}"`);
    if (!t.primaryKey.length && (updates.length || deletes.length)) throw new Error(`Table "${t.name}" has no primary key; rows cannot be updated or deleted`);
    for (const col of [...updates.flatMap((u) => Object.keys(u.set)), ...inserts.flatMap((r) => Object.keys(r))])
      if (!colOf(t, col)) throw new Error(`column "${col}" of relation "${t.name}" does not exist`);
    const name = tableName(k, t);
    const statements: string[] = [];
    for (const pk of deletes) statements.push(`DELETE FROM ${name} WHERE ${renderPkWhere(k, pk)}`);
    for (const u of updates) {
      const sets = Object.entries(u.set).map(([c, v]) => `${quoteIdent(k, c)} = ${sqlLiteral(k, v)}`);
      if (sets.length) statements.push(`UPDATE ${name} SET ${sets.join(', ')} WHERE ${renderPkWhere(k, u.pk)}`);
    }
    for (const row of inserts) {
      const entries = Object.entries(row);
      if (!entries.length) statements.push(k === 'mysql' ? `INSERT INTO ${name} () VALUES ()` : `INSERT INTO ${name} DEFAULT VALUES`);
      else statements.push(`INSERT INTO ${name} (${entries.map(([c]) => quoteIdent(k, c)).join(', ')}) VALUES (${entries.map(([, v]) => sqlLiteral(k, v)).join(', ')})`);
    }
    await sleep(req.preview ? 60 : 150);
    if (req.preview) return { statements, applied: 0 };
    if (profile.readOnly) throw new Error(`Connection "${profile.name}" is read-only`);

    const rows = rowsOf(db, t);
    const snapshot = rows.map((r) => [...r]);
    const pkIdx = t.primaryKey.map((c) => t.columns.findIndex((x) => x.name === c));
    const findRow = (pk: Record<string, Value>) => rows.findIndex((r) => pkIdx.every((i) => looseEqual(r[i], pk[t.columns[i].name] ?? NUL)));
    try {
      let applied = 0;
      for (const pk of deletes) {
        const at = findRow(pk);
        if (at >= 0) {
          rows.splice(at, 1);
          applied++;
        }
      }
      for (const u of updates) {
        const at = findRow(u.pk);
        if (at < 0) continue;
        const row = rows[at];
        for (const [c, v] of Object.entries(u.set)) {
          const ci = t.columns.findIndex((x) => x.name === c);
          const col = t.columns[ci];
          const value = coerceTo(v, col, k);
          if (value.t === 'null' && !col.nullable) throw new SqlError(`null value in column "${col.name}" of relation "${t.name}" violates not-null constraint`, '23502');
          row[ci] = value;
        }
        applied++;
      }
      for (const r of inserts) {
        const m = new Map<number, Value>();
        for (const [c, v] of Object.entries(r)) m.set(t.columns.findIndex((x) => x.name === c), v);
        insertRow(db, t, m);
        applied++;
      }
      return { statements, applied };
    } catch (err) {
      rows.length = 0;
      rows.push(...snapshot);
      throw asError(err);
    }
  },

  // -- workspace ------------------------------------------------------------------
  'history.list': (req) => {
    const search = req?.search?.trim().toLowerCase();
    let list = history();
    if (req?.profileId) list = list.filter((h) => h.profileId === req.profileId);
    if (search) list = list.filter((h) => h.sql.toLowerCase().includes(search) || h.connectionName.toLowerCase().includes(search));
    return [...list].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, req?.limit ?? 200);
  },
  'history.clear': () => {
    historyCache = [];
    saveJson('history', []);
  },
  'snippets.list': () => [...snippets()].sort((a, b) => a.name.localeCompare(b.name)),
  'snippets.save': (req) => {
    if (!req.name?.trim()) throw new Error('Snippet name is required');
    const list = snippets();
    const saved: Snippet = { ...req, id: req.id || newMockId(), name: req.name.trim(), updatedAt: new Date().toISOString() };
    const idx = list.findIndex((s) => s.id === saved.id);
    if (idx >= 0) list[idx] = saved;
    else list.push(saved);
    saveJson('snippets', list);
    return saved;
  },
  'snippets.delete': (req) => {
    snippetsCache = snippets().filter((s) => s.id !== req.id);
    saveJson('snippets', snippetsCache);
  },
  'settings.get': () => settings(),
  'settings.update': (req, ctx) => {
    const next: AppSettings = { ...settings(), ...req };
    saveJson('settings', next);
    ctx.emit('settings.changed', next);
    return next;
  },
  'session.load': () => peekJson<unknown>('session'),
  'session.save': (req) => {
    saveJson('session', req);
  }
};
