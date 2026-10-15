/**
 * MySQL / MariaDB driver (mysql2).
 *
 * One dedicated session connection runs `execute` statement by statement
 * (serialized by a mutex) so SET, USE, temp tables, and explicit
 * transactions persist; a small pool serves browsing, paging, edits, and
 * KILL QUERY.
 *
 * Row cap: rows are read from query events; past the cap they are not
 * materialized. For read-only statements the server is also told to stop
 * (`KILL QUERY <thread>` from the pool, which ends the statement but keeps
 * the session and its transaction). Writes and CALLs are drained instead, so
 * capping a result never changes what a statement does.
 *
 * Values: a typeCast hands back raw bytes for every column; `mysql-values`
 * interprets them (dates as text, BIGINT/DECIMAL exact).
 */
import mysql from 'mysql2';
import type { Connection, ConnectionOptions, FieldPacket, Pool, ResultSetHeader, TypeCast } from 'mysql2';
import type { Pool as PromisePool } from 'mysql2/promise';
import { isReadOnlyStatement, splitStatements, type StatementSpan } from '@shared/sql';
import type { ApplyChangesResult, ConnectionProfile, QueryError, ResultSet, RoutineKind, RowChangeSet, TablePage } from '@shared/types';
import { AppError } from '../errors';
import * as catalog from './mysql-catalog';
import { mysqlErrorOffset, mysqlParam, mysqlTypeName, mysqlValue, type MysqlField } from './mysql-values';
import { Mutex, closeQuietly, elapsedMs, errorMessage, newResult, runStatements } from './common';
import { buildChangeStatements, buildCountQuery, buildPageQuery, rowMismatchError } from './dialect';
import { QueryFailure, type ConnectOptions, type Driver, type ExecuteOptions, type FetchRowsSpec, type SessionContext } from './driver';

/** Raw wire bytes for every column; see mysql-values. */
const RAW_CAST: TypeCast = (field) => field.buffer();

const RESET_NOTICE = 'The connection was lost and re-established; session state (variables, temp tables, open transaction) was reset.';
const ER_QUERY_INTERRUPTED = 1317;

export function mysqlConnectionOptions(profile: ConnectionProfile, password: string | null, database: string, opts: ConnectOptions): ConnectionOptions {
  return {
    host: profile.host || 'localhost',
    port: profile.port || 3306,
    user: profile.username || undefined,
    password: password ?? undefined,
    database: database || undefined,
    ssl: profile.ssl ? { rejectUnauthorized: !profile.trustServerCertificate } : undefined,
    connectTimeout: opts.connectTimeoutMs ?? 15_000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    enableKeepAlive: true,
    // Never let a server request local files (LOAD DATA LOCAL INFILE).
    flags: ['-LOCAL_FILES']
  };
}

interface MysqlErrorFields {
  message?: string;
  errno?: number;
  code?: string;
  sqlState?: string;
  sqlMessage?: string;
  fatal?: boolean;
}

export function mysqlQueryError(err: unknown, stmt: StatementSpan, index: number): QueryError {
  const e = (typeof err === 'object' && err ? err : {}) as MysqlErrorFields;
  const message = e.sqlMessage ?? e.message ?? errorMessage(err);
  const error: QueryError = { message, statementIndex: index };
  if (e.errno !== undefined) error.code = String(e.errno);
  else if (e.code) error.code = e.code;
  if (e.sqlState) error.detail = `SQLSTATE ${e.sqlState}${e.code ? ` (${e.code})` : ''}`;
  const offset = mysqlErrorOffset(stmt.text, message);
  if (offset !== undefined) error.position = stmt.start + offset;
  return error;
}

function isRowArray(row: unknown): row is (Buffer | null)[] {
  return Array.isArray(row);
}

function toField(f: FieldPacket): MysqlField {
  return {
    name: f.name,
    columnType: f.columnType ?? f.type ?? 0,
    characterSet: f.characterSet ?? f.charsetNr ?? 0,
    flags: typeof f.flags === 'number' ? f.flags : 0,
    columnLength: f.columnLength ?? f.length ?? 0
  };
}

export class MysqlDriver implements Driver {
  readonly kind = 'mysql' as const;
  private readonly pool: Pool;
  private readonly db: PromisePool;
  private readonly lock = new Mutex();
  private session: Connection | null = null;
  private threadId = 0;
  private sessionWasReset = false;
  private closed = false;
  /** A statement is running on the session (close() must stop it rather than queue QUIT behind it). */
  private running = false;

  private constructor(
    private readonly options: ConnectionOptions,
    private readonly readOnly: boolean,
    readonly database: string
  ) {
    // mysql2 only reaps idle connections down to maxIdle when maxIdle < connectionLimit.
    this.pool = mysql.createPool({ ...options, connectionLimit: 3, waitForConnections: true, maxIdle: 1, idleTimeout: 60_000 });
    // The callback keeps a failure from surfacing as an unhandled 'error' event.
    if (readOnly) this.pool.on('connection', (conn) => conn.query('SET SESSION TRANSACTION READ ONLY', () => undefined));
    this.db = this.pool.promise();
  }

  static async connect(profile: ConnectionProfile, password: string | null, database: string, opts: ConnectOptions = {}): Promise<MysqlDriver> {
    const driver = new MysqlDriver(mysqlConnectionOptions(profile, password, database, opts), !!opts.readOnly, database);
    try {
      await driver.openSession();
    } catch (err) {
      await driver.close();
      throw err;
    }
    return driver;
  }

  private async openSession(): Promise<Connection> {
    if (this.session) return this.session;
    if (this.closed) throw new AppError('Connection is closed', 'CLOSED');
    const conn = mysql.createConnection(this.options);
    const lost = () => {
      if (this.session !== conn) return;
      this.session = null;
      this.sessionWasReset = true;
    };
    conn.on('error', lost);
    conn.on('end', lost);
    await new Promise<void>((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())));
    if (this.readOnly) await new Promise<void>((resolve, reject) => conn.query('SET SESSION TRANSACTION READ ONLY', (err) => (err ? reject(err) : resolve())));
    this.threadId = conn.threadId ?? 0;
    this.session = conn;
    return conn;
  }

  async serverVersion(): Promise<string> {
    const [r] = await this.db.query<(mysql.RowDataPacket & { v: string })[]>('SELECT VERSION() AS v');
    const v = String(r[0]?.v ?? '');
    return /mariadb/i.test(v) ? `MariaDB ${v.replace(/-?mariadb.*$/i, '')}` : `MySQL ${v}`;
  }

  async ping(): Promise<void> {
    await this.db.query('SELECT 1');
  }

  async close(): Promise<void> {
    this.closed = true;
    const session = this.session;
    this.session = null;
    if (session && this.running) {
      // end() would queue QUIT behind the running statement; stop it on the server and drop the socket.
      await closeQuietly(() => this.killQuery(this.threadId));
      session.destroy();
    } else if (session) {
      await closeQuietly(() => new Promise<void>((resolve) => session.end(() => resolve())));
    }
    await closeQuietly(() => this.db.end());
  }

  async sessionContext(): Promise<SessionContext> {
    const current = await this.lock.run(async () => {
      const conn = await this.openSession();
      return new Promise<string>((resolve, reject) =>
        conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS db', (err, rows) => (err ? reject(err) : resolve(rows[0]?.db == null ? '' : String(rows[0].db))))
      );
    });
    // Edits always name the database explicitly, so a console USE only changes how bare names resolve.
    const db = current || this.database;
    return { searchPath: db ? [db] : [], switchedDatabase: false };
  }

  listDatabases() {
    return catalog.listDatabases(this.db);
  }

  listSchemas() {
    return catalog.listSchemas(this.db);
  }

  listTables(schema: string) {
    return catalog.listTables(this.db, schema);
  }

  listRoutines(schema: string) {
    return catalog.listRoutines(this.db, schema);
  }

  describeTable(schema: string, table: string) {
    return catalog.describeTable(this.db, schema, table);
  }

  tableDdl(schema: string, table: string) {
    return catalog.tableDdl(this.db, schema, table);
  }

  routineDefinition(schema: string, name: string, kind: RoutineKind) {
    return catalog.routineDefinition(this.db, schema, name, kind);
  }

  fetchMeta(opts?: { maxTables?: number }) {
    return catalog.fetchMeta(this.db, opts?.maxTables ?? 2000);
  }

  /** Stop the statement running on the session; the connection and its transaction survive. */
  private killQuery(threadId: number): Promise<void> {
    if (!Number.isInteger(threadId) || threadId <= 0) return Promise.resolve();
    return this.db.query(`KILL QUERY ${threadId}`).then(
      () => undefined,
      () => undefined
    );
  }

  execute(sql: string, opts: ExecuteOptions): Promise<ResultSet[]> {
    const statements = splitStatements(sql, 'mysql');
    return this.lock.run(async () => {
      const conn = await this.openSession();
      const wasReset = this.sessionWasReset;
      this.sessionWasReset = false;
      const note = (results: ResultSet[]) => {
        if (wasReset && results[0]) results[0].messages = [RESET_NOTICE, ...(results[0].messages ?? [])];
      };
      try {
        const results = await runStatements(statements, opts, (stmt, index) => this.runStatement(conn, stmt, index, opts), mysqlQueryError);
        note(results);
        return results;
      } catch (err) {
        if (err instanceof QueryFailure) note(err.partial);
        throw err;
      }
    });
  }

  /**
   * One statement; may yield several result sets (CALL). A statement that
   * returns no rows yields one result carrying rowsAffected.
   */
  private runStatement(conn: Connection, stmt: StatementSpan, index: number, opts: ExecuteOptions): Promise<ResultSet[]> {
    // The connection died after this run started; its query would never report back.
    if (this.session !== conn) return Promise.reject(new Error('The connection to the server was lost'));
    const started = performance.now();
    const threadId = this.threadId;
    const killable = isReadOnlyStatement(stmt.text, 'mysql');
    let cancelKill: Promise<void> | null = null;
    const onAbort = () => {
      cancelKill = this.killQuery(threadId);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    this.running = true;

    return new Promise<ResultSet[]>((resolve, reject) => {
      const sets: ResultSet[] = [];
      let fields: MysqlField[] = [];
      let current: ResultSet | null = null;
      let affected: number | undefined;
      let warnings = 0;
      const info: string[] = [];
      let failure: unknown = null;
      let capKill: Promise<void> | null = null;
      let settled = false;

      // mysql2 reports a dropped connection to the connection, not to a callback-less query (which then never ends).
      const onConnError = (err: unknown) => {
        failure = failure ?? err;
        void finish();
      };
      const onConnEnd = () => {
        failure = failure ?? new Error('The connection to the server was closed');
        void finish();
      };
      conn.once('error', onConnError);
      conn.once('end', onConnEnd);

      const finish = async () => {
        if (settled) return;
        settled = true;
        conn.removeListener('error', onConnError);
        conn.removeListener('end', onConnEnd);
        opts.signal?.removeEventListener('abort', onAbort);
        this.running = false;
        // Wait for any KILL to land so it cannot interrupt the next statement instead.
        if (capKill) await capKill;
        if (cancelKill) await cancelKill;
        const interruptedByCap = capKill !== null && (failure as MysqlErrorFields | null)?.errno === ER_QUERY_INTERRUPTED;
        if (failure && !interruptedByCap) {
          reject(failure);
          return;
        }
        if (sets.length === 0) {
          const summary = newResult(stmt.text, index);
          if (affected !== undefined) summary.rowsAffected = affected;
          sets.push(summary);
        }
        const messages = [...info];
        if (warnings > 0 && !opts.signal?.aborted) messages.push(...(await this.showWarnings(conn)));
        if (interruptedByCap) messages.push('Row cap reached; the server was asked to stop the statement.');
        const last = sets[sets.length - 1];
        if (messages.length > 0) last.messages = [...(last.messages ?? []), ...messages];
        const duration = elapsedMs(started);
        for (const s of sets) s.durationMs = duration;
        resolve(sets);
      };

      const query = conn.query({ sql: stmt.text, rowsAsArray: true, typeCast: RAW_CAST });
      // Listener exceptions land in mysql2's packet handler and would kill the connection; record them instead.
      query.on('fields', (packets: FieldPacket[] | undefined) => {
        if (!packets) return;
        try {
          fields = packets.map(toField);
          current = newResult(stmt.text, index);
          current.columns = fields.map((f) => ({ name: f.name, type: mysqlTypeName(f) }));
          sets.push(current);
        } catch (err) {
          failure = failure ?? err;
        }
      });
      query.on('result', (row: unknown) => {
        try {
          if (!isRowArray(row)) {
            const header = row as ResultSetHeader;
            affected = (affected ?? 0) + (header.affectedRows ?? 0);
            warnings += header.warningStatus ?? 0;
            if (header.info) info.push(header.info.trim());
            return;
          }
          if (!current) return;
          if (opts.rowCap === 0 || current.rows.length < opts.rowCap) {
            current.rows.push(row.map((raw, i) => mysqlValue(fields[i], raw)));
          } else if (!current.truncated) {
            current.truncated = true;
            if (killable && !capKill) capKill = this.killQuery(threadId);
          }
        } catch (err) {
          failure = failure ?? err;
        }
      });
      query.on('error', (err: MysqlErrorFields) => {
        failure = failure ?? err;
        // A fatal (connection-level) error may not be followed by 'end'.
        if (err.fatal) void finish();
      });
      query.on('end', () => void finish());
    });
  }

  private showWarnings(conn: Connection): Promise<string[]> {
    return new Promise((resolve) => {
      conn.query<mysql.RowDataPacket[]>('SHOW WARNINGS', (err, rows) => {
        if (err || !Array.isArray(rows)) return resolve([]);
        resolve(rows.map((r) => `${String(r.Level ?? 'Warning')} ${String(r.Code ?? '')}: ${String(r.Message ?? '')}`));
      });
    });
  }

  async fetchRows(spec: FetchRowsSpec): Promise<TablePage> {
    const started = performance.now();
    const pk = await catalog.primaryKey(this.db, spec.schema, spec.table);
    const sql = buildPageQuery('mysql', spec, pk);
    const [page, count] = await Promise.all([
      this.db.query<mysql.RowDataPacket[]>({ sql, rowsAsArray: true, typeCast: RAW_CAST }),
      spec.countTotal ? this.db.query<(mysql.RowDataPacket & { total: unknown })[]>(buildCountQuery('mysql', spec)) : Promise.resolve(null)
    ]);
    const [rows, packets] = page;
    const fields = (packets ?? []).map(toField);
    const result = newResult(sql, 0);
    result.columns = fields.map((f) => ({ name: f.name, type: mysqlTypeName(f) }));
    result.rows = (rows as unknown as (Buffer | null)[][]).map((row) => row.map((raw, i) => mysqlValue(fields[i], raw)));
    result.durationMs = elapsedMs(started);
    return { result, total: count ? Number(count[0][0]?.total ?? 0) : null, primaryKey: pk };
  }

  async applyChanges(schema: string, table: string, changes: RowChangeSet, opts: { preview: boolean }): Promise<ApplyChangesResult> {
    const pk = await catalog.primaryKey(this.db, schema, table);
    const statements = buildChangeStatements('mysql', schema, table, changes, pk);
    const rendered = statements.map((s) => s.preview);
    if (opts.preview || statements.length === 0) return { statements: rendered, applied: 0 };
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      let applied = 0;
      for (const stmt of statements) {
        // Server-side prepared statements: no client-side escaping, so sql_mode cannot change how values are read.
        const [res] = await conn.execute<ResultSetHeader>(stmt.sql, stmt.params.map(mysqlParam) as never[]);
        const count = res.affectedRows ?? 0;
        if (stmt.expectOneRow && count !== 1) throw rowMismatchError(stmt, count);
        applied += count;
      }
      await conn.commit();
      return { statements: rendered, applied };
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }
}
