/**
 * PostgreSQL driver (node-postgres).
 *
 * Two kinds of connections:
 *  - one dedicated session client for `execute`, serialized by a mutex, so
 *    SET, temp tables, and BEGIN...COMMIT persist across runs like psql;
 *  - a small pool for catalog browsing, paging, edits, and pg_cancel_backend,
 *    so the sidebar never waits behind a long query.
 *
 * Row cap: row-returning statements run through an unnamed portal that asks
 * for cap+1 rows (extended protocol Execute with a row limit). If the portal
 * is suspended (more rows exist) it is closed instead of read: the server
 * stops producing rows, nothing is cancelled, and an open transaction stays
 * healthy. pg-cursor is not installed; `SessionQuery` is the minimal version
 * of it. Other statements use the simple protocol, keeping at most cap rows.
 */
import pg from 'pg';
import { containsKeyword, leadingKeyword, splitStatements, type StatementSpan } from '@shared/sql';
import type { ApplyChangesResult, ConnectionProfile, QueryError, ResultSet, RoutineKind, RowChangeSet, TablePage } from '@shared/types';
import { AppError } from '../errors';
import * as catalog from './postgres-catalog';
import { parsePgArray, pgMapper, pgParam, pgTypeName, type PgTypeInfo } from './postgres-values';
import { Mutex, closeQuietly, codePointsToIndex, elapsedMs, errorMessage, newResult, runStatements } from './common';
import { buildChangeStatements, buildCountQuery, buildPageQuery, rowMismatchError } from './dialect';
import { QueryFailure, type ConnectOptions, type Driver, type ExecuteOptions, type FetchRowsSpec, type SessionContext } from './driver';

/** Return server text for every type; `postgres-values` interprets it. */
const RAW_TYPES = {
  // node-postgres' CustomTypesConfig is typed with pg-types' overloads; this parser ignores the OID.
  getTypeParser: () => (value: string) => value
} as unknown as pg.CustomTypesConfig;

const RESET_NOTICE = 'The connection was lost and re-established; session state (SET, temp tables, open transaction) was reset.';

/** Statements that produce rows and are worth a capped portal. */
const ROW_STARTERS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'FETCH']);
const COUNTED_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'MOVE']);

export function returnsRows(text: string): boolean {
  return ROW_STARTERS.has(leadingKeyword(text, 'postgres')) || containsKeyword(text, 'returning', 'postgres');
}

// -- portal-capped query -----------------------------------------------------

/** The parts of node-postgres' Connection and Query internals a Submittable uses (pg-cursor relies on the same). */
interface WireConnection {
  close(msg: { type: 'P' | 'S'; name: string }): void;
  sync(): void;
}
interface QueryInternals {
  handleCommandComplete(msg: unknown, connection: WireConnection): void;
  handleError(err: Error, connection: WireConnection): void;
}
const baseQuery = pg.Query.prototype as unknown as QueryInternals;

interface PgField {
  name: string;
  dataTypeID: number;
}
interface PgResultMeta {
  fields: PgField[];
  command: string | null;
  rowCount: number | null;
}

class SessionQuery extends pg.Query {
  readonly kept: (string | null)[][] = [];
  truncated = false;
  private synced = false;

  constructor(
    text: string,
    cap: number,
    private readonly usePortal: boolean
  ) {
    // `rows` (portal row limit) is a node-postgres option that @types/pg does not declare.
    super({ text, rowMode: 'array', rows: usePortal ? cap + 1 : undefined } as pg.QueryConfig);
    this.on('row', (row: (string | null)[]) => {
      if (cap === 0 || this.kept.length < cap) this.kept.push(row);
      else this.truncated = true;
    });
  }

  /** More rows than cap+1 exist: close the portal instead of fetching them. */
  handlePortalSuspended(connection: WireConnection): void {
    this.truncated = true;
    this.synced = true;
    connection.close({ type: 'P', name: '' });
    connection.sync();
  }

  handleCommandComplete(msg: unknown, connection: WireConnection): void {
    if (this.usePortal) this.synced = true; // the base class sends Sync for portal queries
    baseQuery.handleCommandComplete.call(this, msg, connection);
  }

  handleError(err: Error, connection: WireConnection): void {
    // With a row limit no Sync was pipelined; without one the backend never sends ReadyForQuery.
    if (this.usePortal && !this.synced) {
      this.synced = true;
      connection.sync();
    }
    baseQuery.handleError.call(this, err, connection);
  }
}

/** Force the extended protocol (a node-postgres option missing from @types/pg): one Parse refuses multi-statement text. */
function extended<T extends pg.QueryConfig>(cfg: T): T {
  return Object.assign(cfg, { queryMode: 'extended' as const });
}

function submit(client: pg.Client, query: SessionQuery): Promise<PgResultMeta> {
  return new Promise((resolve, reject) => {
    query.once('end', (res: unknown) => resolve((Array.isArray(res) ? res[res.length - 1] : res) as PgResultMeta));
    query.once('error', reject);
    client.query(query);
  });
}

// -- type names --------------------------------------------------------------

/** OID -> type info, loaded from pg_type on first use and refreshed when an unknown OID appears (new enum, domain). */
class PgTypeCache {
  private map = new Map<number, PgTypeInfo>();
  private loaded = false;
  private readonly misses = new Set<number>();

  constructor(private readonly pool: pg.Pool) {}

  async ensure(oids: number[]): Promise<void> {
    const unknown = oids.filter((o) => !this.map.has(o) && !this.misses.has(o));
    if (this.loaded && unknown.length === 0) return;
    const { rows } = await this.pool.query<{ oid: number; name: string; category: string; elem: number; base: number }>(
      `SELECT oid::int8::float8 AS oid, typname AS name, typcategory AS category,
              typelem::int8::float8 AS elem, typbasetype::int8::float8 AS base
       FROM pg_catalog.pg_type`
    );
    const map = new Map<number, PgTypeInfo>();
    for (const r of rows) map.set(Number(r.oid), { oid: Number(r.oid), name: r.name, category: r.category });
    for (const r of rows) {
      const info = map.get(Number(r.oid));
      if (!info) continue;
      if (r.elem) info.elem = map.get(Number(r.elem));
      if (r.base) info.base = map.get(Number(r.base));
    }
    this.map = map;
    this.loaded = true;
    for (const o of unknown) if (!map.has(o)) this.misses.add(o);
  }

  get(oid: number): PgTypeInfo | undefined {
    return this.map.get(oid);
  }
}

// -- errors -------------------------------------------------------------------

interface PgErrorFields {
  message?: string;
  code?: string;
  position?: string;
  detail?: string;
  hint?: string;
  where?: string;
}

export function pgQueryError(err: unknown, stmt: StatementSpan, index: number): QueryError {
  const e = (typeof err === 'object' && err ? err : {}) as PgErrorFields;
  const error: QueryError = { message: e.message ?? errorMessage(err), statementIndex: index };
  if (e.code) error.code = e.code;
  // `position` is 1-based and counts characters within the statement we sent.
  const pos = Number(e.position);
  if (Number.isInteger(pos) && pos > 0) error.position = stmt.start + codePointsToIndex(stmt.text, pos - 1);
  if (e.detail) error.detail = e.detail;
  if (e.hint) error.hint = e.hint;
  else if (e.where) error.detail = error.detail ? `${error.detail}\n${e.where}` : e.where;
  return error;
}

function formatNotice(n: { severity?: string; message?: string }): string {
  return `${n.severity ?? 'NOTICE'}: ${n.message ?? ''}`;
}

// -- driver -------------------------------------------------------------------

export function pgClientConfig(profile: ConnectionProfile, password: string | null, database: string, opts: ConnectOptions): pg.ClientConfig {
  return {
    host: profile.host || 'localhost',
    port: profile.port || 5432,
    user: profile.username || undefined,
    password: password ?? undefined,
    database: database || undefined,
    ssl: profile.ssl ? { rejectUnauthorized: !profile.trustServerCertificate } : false,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? 15_000,
    application_name: 'database-tool',
    keepAlive: true,
    options: opts.readOnly ? '-c default_transaction_read_only=on' : undefined
  };
}

export class PostgresDriver implements Driver {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly types: PgTypeCache;
  private readonly lock = new Mutex();
  private session: pg.Client | null = null;
  private sessionPid = 0;
  private sessionWasReset = false;
  private notices: string[] | null = null;
  private closed = false;
  /** A statement is running on the session (close() cancels it so the server stops too). */
  private running = false;

  private constructor(
    private readonly config: pg.ClientConfig,
    readonly database: string
  ) {
    this.pool = new pg.Pool({ ...config, max: 3, idleTimeoutMillis: 60_000 });
    // An idle pooled client can die (server restart); the pool discards it. Without a listener Node would crash.
    this.pool.on('error', () => undefined);
    this.types = new PgTypeCache(this.pool);
  }

  static async connect(profile: ConnectionProfile, password: string | null, database: string, opts: ConnectOptions = {}): Promise<PostgresDriver> {
    const driver = new PostgresDriver(pgClientConfig(profile, password, database, opts), database || profile.username);
    try {
      await driver.openSession();
    } catch (err) {
      await driver.close();
      throw err;
    }
    return driver;
  }

  private async openSession(): Promise<pg.Client> {
    if (this.session) return this.session;
    if (this.closed) throw new AppError('Connection is closed', 'CLOSED');
    const client = new pg.Client({ ...this.config, types: RAW_TYPES });
    const lost = () => {
      if (this.session !== client) return;
      this.session = null;
      this.sessionWasReset = true;
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notice', (n) => this.notices?.push(formatNotice(n)));
    await client.connect();
    const { rows } = await client.query<{ pid: string }>('SELECT pg_backend_pid() AS pid');
    this.sessionPid = Number(rows[0]?.pid ?? 0);
    this.session = client;
    return client;
  }

  async serverVersion(): Promise<string> {
    const { rows } = await this.pool.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
    return `PostgreSQL ${rows[0]?.v ?? ''}`.trim();
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    this.closed = true;
    const session = this.session;
    this.session = null;
    // The server only reads Terminate after the current statement; cancel it first.
    if (session && this.running) await closeQuietly(() => this.pool.query('SELECT pg_cancel_backend($1)', [this.sessionPid]));
    if (session) await closeQuietly(() => session.end());
    await closeQuietly(() => this.pool.end());
  }

  async sessionContext(): Promise<SessionContext> {
    const path = await this.lock.run(async () => {
      const client = await this.openSession();
      const { rows } = await client.query<{ p: string }>('SELECT current_schemas(false)::text AS p');
      return rows[0]?.p ?? '{}';
    });
    return { searchPath: parsePgArray(path).filter((s): s is string => typeof s === 'string'), switchedDatabase: false };
  }

  listDatabases() {
    return catalog.listDatabases(this.pool);
  }

  listSchemas() {
    return catalog.listSchemas(this.pool);
  }

  listTables(schema: string) {
    return catalog.listTables(this.pool, schema);
  }

  listRoutines(schema: string) {
    return catalog.listRoutines(this.pool, schema);
  }

  describeTable(schema: string, table: string) {
    return catalog.describeTable(this.pool, schema, table);
  }

  tableDdl(schema: string, table: string) {
    return catalog.tableDdl(this.pool, schema, table);
  }

  routineDefinition(schema: string, name: string, kind: RoutineKind) {
    return catalog.routineDefinition(this.pool, schema, name, kind);
  }

  fetchMeta(opts?: { maxTables?: number }) {
    return catalog.fetchMeta(this.pool, opts?.maxTables ?? 2000);
  }

  execute(sql: string, opts: ExecuteOptions): Promise<ResultSet[]> {
    const statements = splitStatements(sql, 'postgres');
    return this.lock.run(async () => {
      const client = await this.openSession();
      const wasReset = this.sessionWasReset;
      this.sessionWasReset = false;
      const note = (results: ResultSet[]) => {
        if (wasReset && results[0]) results[0].messages = [RESET_NOTICE, ...(results[0].messages ?? [])];
      };
      try {
        const results = await runStatements(statements, opts, (stmt, index) => this.runStatement(client, stmt, index, opts), pgQueryError);
        note(results);
        return results;
      } catch (err) {
        if (err instanceof QueryFailure) note(err.partial);
        throw err;
      }
    });
  }

  private async runStatement(client: pg.Client, stmt: StatementSpan, index: number, opts: ExecuteOptions): Promise<ResultSet[]> {
    const started = performance.now();
    const query = new SessionQuery(stmt.text, opts.rowCap, opts.rowCap > 0 && returnsRows(stmt.text));
    const notices: string[] = [];
    this.notices = notices;
    const pid = this.sessionPid;
    // Cancel server-side from a pooled connection; the session stays protocol-clean.
    const onAbort = () => void this.pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    this.running = true;
    try {
      const meta = await submit(client, query);
      const result = await this.toResult(stmt.text, index, meta.fields, query.kept);
      result.truncated = query.truncated;
      if (meta.rowCount !== null && (meta.fields.length === 0 || (meta.command !== null && COUNTED_COMMANDS.has(meta.command)))) {
        result.rowsAffected = meta.rowCount;
      }
      if (notices.length > 0) result.messages = notices;
      result.durationMs = elapsedMs(started);
      return [result];
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      this.notices = null;
      this.running = false;
    }
  }

  private async toResult(statement: string, index: number, fields: PgField[], rows: (string | null)[][]): Promise<ResultSet> {
    await this.types.ensure(fields.map((f) => f.dataTypeID));
    const infos = fields.map((f) => this.types.get(f.dataTypeID));
    const mappers = infos.map((info) => pgMapper(info));
    const result = newResult(statement, index);
    result.columns = fields.map((f, i) => ({ name: f.name, type: pgTypeName(infos[i], f.dataTypeID) }));
    result.rows = rows.map((row) => row.map((raw, i) => mappers[i](raw)));
    return result;
  }

  async fetchRows(spec: FetchRowsSpec): Promise<TablePage> {
    const started = performance.now();
    const pk = await catalog.primaryKey(this.pool, spec.schema, spec.table);
    const text = buildPageQuery('postgres', spec, pk);
    // Extended protocol refuses multiple statements, so a WHERE body cannot smuggle in a second one.
    const [page, count] = await Promise.all([
      this.pool.query<(string | null)[]>(extended<pg.QueryArrayConfig>({ text, rowMode: 'array', types: RAW_TYPES })),
      spec.countTotal ? this.pool.query<{ total: string }>(extended({ text: buildCountQuery('postgres', spec) })) : Promise.resolve(null)
    ]);
    const result = await this.toResult(text, 0, page.fields, page.rows);
    result.durationMs = elapsedMs(started);
    return { result, total: count ? Number(count.rows[0]?.total ?? 0) : null, primaryKey: pk };
  }

  async applyChanges(schema: string, table: string, changes: RowChangeSet, opts: { preview: boolean }): Promise<ApplyChangesResult> {
    const pk = await catalog.primaryKey(this.pool, schema, table);
    const statements = buildChangeStatements('postgres', schema, table, changes, pk);
    const rendered = statements.map((s) => s.preview);
    if (opts.preview || statements.length === 0) return { statements: rendered, applied: 0 };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Fail fast instead of hanging if the console session holds a lock on these rows.
      await client.query(`SET LOCAL lock_timeout = '15s'`);
      let applied = 0;
      for (const stmt of statements) {
        const res = await client.query(stmt.sql, stmt.params.map(pgParam));
        const affected = res.rowCount ?? 0;
        if (stmt.expectOneRow && affected !== 1) throw rowMismatchError(stmt, affected);
        applied += affected;
      }
      await client.query('COMMIT');
      return { statements: rendered, applied };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
