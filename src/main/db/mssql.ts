/**
 * SQL Server driver (mssql over tedious).
 *
 * Execution unit is the batch (text between `GO` lines), as in SSMS: a batch
 * keeps its variables, IF/ELSE, and TRY/CATCH together and may return many
 * recordsets plus PRINT/info messages. Batches run on a dedicated
 * single-connection pool via `request.batch()` (sp_executesql would scope
 * #temp tables and SET options to one call), serialized by a mutex, so
 * session state persists across runs. A separate small pool serves browsing,
 * paging, and edits.
 *
 * Row cap: rows past the cap are never materialized. If the batch is
 * read-only the request is cancelled (TDS attention) once the cap is hit;
 * otherwise the rest is drained so capping never skips later statements in
 * the batch.
 *
 * Cancellation: `request.cancel()`. Values: see mssql-values.
 */
import sql from 'mssql';
import { containsKeyword, isReadOnlyScript, splitBatches, type BatchSpan } from '@shared/sql';
import type { ApplyChangesResult, ConnectionProfile, QueryError, ResultSet, RoutineKind, RowChangeSet, TablePage } from '@shared/types';
import * as catalog from './mssql-catalog';
import { mssqlParam, mssqlTypeName, mssqlValue, type MssqlColumn } from './mssql-values';
import { Mutex, closeQuietly, elapsedMs, errorMessage, lineToOffset, newResult, runStatements } from './common';
import { buildChangeStatements, buildCountQuery, buildPageQuery, rowMismatchError } from './dialect';
import { QueryFailure, type ConnectOptions, type Driver, type ExecuteOptions, type FetchRowsSpec, type SessionContext } from './driver';

/** Keeps the single session connection open indefinitely (tarn reaps idle connections otherwise). */
const SESSION_IDLE_MS = 2 ** 31 - 1;

/** Build the mssql config from a profile. `role` picks the pool shape and request timeout. */
export function mssqlConfig(profile: ConnectionProfile, password: string | null, database: string, opts: ConnectOptions, role: 'session' | 'browse'): sql.config {
  const extra = profile.options ?? {};
  const instanceName = extra.instanceName?.trim() || undefined;
  const domain = extra.domain?.trim() || undefined;
  return {
    server: profile.host || 'localhost',
    // A named instance is resolved through SQL Browser (UDP 1434); a port would bypass it.
    port: instanceName ? undefined : profile.port || 1433,
    database: database || undefined,
    user: profile.username || undefined,
    password: password ?? undefined,
    domain,
    connectionTimeout: opts.connectTimeoutMs ?? 15_000,
    // Console queries may run as long as the user wants (0 = no timeout); browsing should not hang.
    requestTimeout: role === 'session' ? 0 : 60_000,
    validateConnection: 'socket',
    pool: role === 'session' ? { min: 0, max: 1, idleTimeoutMillis: SESSION_IDLE_MS } : { min: 0, max: 3, idleTimeoutMillis: 60_000 },
    options: {
      encrypt: profile.ssl,
      trustServerCertificate: profile.trustServerCertificate,
      instanceName,
      appName: extra.applicationName?.trim() || 'database-tool',
      useUTC: true,
      enableArithAbort: true
    }
  };
}

interface MssqlErrorFields {
  message?: string;
  /** Server error number; mssql puts its own string code (ECANCEL, ESOCKET) here for client-side errors. */
  number?: number | string;
  code?: string;
  lineNumber?: number;
  state?: number;
  class?: number;
  procName?: string;
}

export function mssqlQueryError(err: unknown, batch: BatchSpan, index: number, more: unknown[] = []): QueryError {
  const e = (typeof err === 'object' && err ? err : {}) as MssqlErrorFields;
  const error: QueryError = { message: e.message ?? errorMessage(err), statementIndex: index };
  const serverError = typeof e.number === 'number';
  if (e.number !== undefined) error.code = String(e.number);
  else if (e.code) error.code = e.code;
  // Line numbers are relative to the batch, unless the error was raised inside a module.
  if (e.lineNumber && !e.procName) error.position = batch.start + lineToOffset(batch.text, e.lineNumber);
  const details: string[] = [];
  if (serverError) details.push(`Msg ${e.number}, Level ${e.class ?? '?'}, State ${e.state ?? '?'}${e.procName ? `, Procedure ${e.procName}` : ''}${e.lineNumber ? `, Line ${e.lineNumber}` : ''}`);
  for (const m of more) details.push(errorMessage(m));
  if (details.length > 0) error.detail = details.join('\n');
  return error;
}

/** Recordset column metadata as mssql emits it (createColumns in mssql/lib/tedious/request.js). */
interface RawColumn {
  name: string;
  type?: { declaration?: string };
  scale?: number;
  udt?: { name?: string };
}

function toColumn(c: RawColumn): MssqlColumn {
  const col: MssqlColumn = { name: c.name, declaration: c.type?.declaration ?? '' };
  if (typeof c.scale === 'number') col.scale = c.scale;
  if (c.udt?.name) col.udtName = c.udt.name;
  return col;
}

/**
 * Cells of a streamed row. mssql emits arrays in arrayRowMode, except for
 * FOR JSON / FOR XML results, whose chunks it reassembles into a one-key object.
 */
export function rowCells(row: unknown): unknown[] {
  if (Array.isArray(row)) return row;
  return row && typeof row === 'object' ? Object.values(row) : [row];
}

/** Words that mean a batch manages a transaction; cancelling it mid-way could leave one open or roll one back. */
const TRANSACTION_WORDS = ['tran', 'transaction', 'commit', 'rollback', 'save', 'xact_abort', 'implicit_transactions'];

function isCancelError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === 'ECANCEL' || /cancel/i.test(e?.message ?? '');
}

function bind(req: sql.Request, params: ReturnType<typeof mssqlParam>[]): void {
  params.forEach((p, i) => {
    const name = `p${i + 1}`;
    switch (p.type) {
      case 'bit':
        req.input(name, sql.Bit, p.value);
        break;
      case 'float':
        req.input(name, sql.Float, p.value);
        break;
      case 'varbinary':
        req.input(name, sql.VarBinary(sql.MAX), p.value);
        break;
      default:
        req.input(name, sql.NVarChar(sql.MAX), p.value);
    }
  });
}

/**
 * Logins on the session pool. tarn silently replaces a dropped connection
 * (idle timeouts on Azure or NAT), which loses #temp tables and open
 * transactions; counting logins lets the next run say so.
 */
interface LoginCounter {
  logins: number;
  /** Count after the previous run; 0 until the first run completes. */
  seen: number;
}

const RESET_NOTICE = 'The connection was lost and re-established; session state (#temp tables, SET options, open transaction) was reset.';

export class MssqlDriver implements Driver {
  readonly kind = 'mssql' as const;
  private readonly lock = new Mutex();
  /** The request running on the session, so close() can cancel it instead of waiting. */
  private active: sql.Request | null = null;
  /**
   * Set once any batch touched transactions or XACT_ABORT: from then on a row
   * cap never cancels (an attention could leave a transaction open or, with
   * XACT_ABORT ON, roll back the user's work); rows are drained instead.
   */
  private transactional = false;
  /** DB_NAME() of the browse connection, to notice a console USE. */
  private browseDatabase: string | null = null;

  private constructor(
    private readonly session: sql.ConnectionPool,
    private readonly browse: sql.ConnectionPool,
    readonly database: string,
    private readonly counter: LoginCounter = { logins: 0, seen: 0 }
  ) {}

  static async connect(profile: ConnectionProfile, password: string | null, database: string, opts: ConnectOptions = {}): Promise<MssqlDriver> {
    const counter: LoginCounter = { logins: 0, seen: 0 };
    const session = new sql.ConnectionPool({
      ...mssqlConfig(profile, password, database, opts, 'session'),
      beforeConnect: () => {
        counter.logins++;
      }
    });
    const browse = new sql.ConnectionPool(mssqlConfig(profile, password, database, opts, 'browse'));
    // Pools emit 'error' when a connection cannot be (re)acquired; requests report it too. Without a listener Node would crash.
    session.on('error', () => undefined);
    browse.on('error', () => undefined);
    // Both logins in parallel: TLS + login to a remote server is the slow part of connecting.
    const [s, b] = await Promise.allSettled([session.connect(), browse.connect()]);
    if (s.status === 'rejected' || b.status === 'rejected') {
      await closeQuietly(() => session.close());
      await closeQuietly(() => browse.close());
      throw s.status === 'rejected' ? s.reason : (b as PromiseRejectedResult).reason;
    }
    // connect() logs in once to validate and then discards that connection; only later logins are session logins.
    counter.logins = 0;
    return new MssqlDriver(session, browse, database, counter);
  }

  /** Prefix a notice to the first result when the session connection was replaced since the last run. */
  private noteReconnect(results: ResultSet[]): void {
    const replaced = this.counter.seen > 0 && this.counter.logins > this.counter.seen;
    this.counter.seen = this.counter.logins;
    if (replaced && results[0]) results[0].messages = [RESET_NOTICE, ...(results[0].messages ?? [])];
  }

  async serverVersion(): Promise<string> {
    const res = await this.browse
      .request()
      .query<{ v: string; e: string }>(`SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS v, CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS e`);
    const row = res.recordset[0];
    return `SQL Server ${row?.v ?? ''}${row?.e ? ` (${row.e})` : ''}`;
  }

  async ping(): Promise<void> {
    await this.browse.request().query('SELECT 1');
  }

  async close(): Promise<void> {
    // Closing waits for in-use connections; cancel a running console batch so it stops on the server too.
    this.active?.cancel();
    await closeQuietly(() => this.session.close());
    await closeQuietly(() => this.browse.close());
  }

  async sessionContext(): Promise<SessionContext> {
    if (this.browseDatabase === null) {
      const res = await this.browse.request().query<{ db: string }>('SELECT DB_NAME() AS db');
      this.browseDatabase = res.recordset[0]?.db ?? '';
    }
    const res = await this.lock.run(() => this.session.request().batch<{ db: string; s: string }>('SELECT DB_NAME() AS db, SCHEMA_NAME() AS s'));
    const row = res.recordset[0];
    // Unqualified names resolve through the user's default schema, then dbo.
    const searchPath = [...new Set([row?.s || 'dbo', 'dbo'])];
    return { searchPath, switchedDatabase: (row?.db ?? '').toLowerCase() !== this.browseDatabase.toLowerCase() };
  }

  listDatabases() {
    return catalog.listDatabases(this.browse);
  }

  listSchemas() {
    return catalog.listSchemas(this.browse);
  }

  listTables(schema: string) {
    return catalog.listTables(this.browse, schema);
  }

  listRoutines(schema: string) {
    return catalog.listRoutines(this.browse, schema);
  }

  describeTable(schema: string, table: string) {
    return catalog.describeTable(this.browse, schema, table);
  }

  tableDdl(schema: string, table: string) {
    return catalog.tableDdl(this.browse, schema, table);
  }

  routineDefinition(schema: string, name: string, kind: RoutineKind) {
    return catalog.routineDefinition(this.browse, schema, name, kind);
  }

  fetchMeta(opts?: { maxTables?: number }) {
    return catalog.fetchMeta(this.browse, opts?.maxTables ?? 2000);
  }

  execute(sqlText: string, opts: ExecuteOptions): Promise<ResultSet[]> {
    const batches = splitBatches(sqlText, 'mssql');
    return this.lock.run(async () => {
      try {
        const results = await runStatements(
          batches,
          opts,
          async (batch, index) => {
            // `GO n` repeats the batch n times, as in SSMS/sqlcmd.
            const all: ResultSet[] = [];
            for (let r = 0; r < batch.repeat; r++) {
              try {
                all.push(...(await this.runBatch(batch, index, opts)));
              } catch (err) {
                if (err instanceof QueryFailure) throw new QueryFailure(err.error, [...all, ...err.partial]);
                throw err;
              }
            }
            return all;
          },
          (err, batch, index) => mssqlQueryError(err, batch, index)
        );
        this.noteReconnect(results);
        return results;
      } catch (err) {
        if (err instanceof QueryFailure) this.noteReconnect(err.partial);
        throw err;
      }
    });
  }

  /** One batch on the session connection; resolves with one result per recordset (or one summary). */
  private runBatch(batch: BatchSpan, index: number, opts: ExecuteOptions): Promise<ResultSet[]> {
    const started = performance.now();
    if (TRANSACTION_WORDS.some((w) => containsKeyword(batch.text, w, 'mssql'))) this.transactional = true;
    const cancelAtCap = !this.transactional && isReadOnlyScript(batch.text, 'mssql');
    const req = this.session.request();
    req.stream = true;
    req.arrayRowMode = true;
    this.active = req;

    return new Promise<ResultSet[]>((resolve, reject) => {
      const sets: ResultSet[] = [];
      let columns: MssqlColumn[] = [];
      let current: ResultSet | null = null;
      const messages: string[] = [];
      const errors: unknown[] = [];
      let affected: number | undefined;
      let cappedCancel = false;

      const onAbort = () => req.cancel();
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      req.on('recordset', (cols: unknown) => {
        columns = (cols as RawColumn[]).map(toColumn);
        current = newResult(batch.text, index);
        current.columns = columns.map((c) => ({ name: c.name, type: mssqlTypeName(c) }));
        sets.push(current);
      });
      req.on('row', (row: unknown) => {
        if (!current) return;
        if (opts.rowCap === 0 || current.rows.length < opts.rowCap) {
          // A throw here would surface inside tedious' token parser and kill the session connection.
          try {
            current.rows.push(rowCells(row).map((v, i) => mssqlValue(columns[i], v)));
          } catch (err) {
            errors.push(err);
          }
        } else if (!current.truncated) {
          current.truncated = true;
          if (cancelAtCap) {
            cappedCancel = true;
            req.cancel();
          }
        }
      });
      req.on('rowsaffected', (n: number) => {
        affected = (affected ?? 0) + n;
        messages.push(`(${n} row${n === 1 ? '' : 's'} affected)`);
      });
      req.on('info', (info: { message?: string }) => {
        if (info.message) messages.push(info.message);
      });
      req.on('error', (err: unknown) => errors.push(err));
      req.on('done', () => {
        // tedious rethrows exceptions from completion handlers on nextTick, which would crash the main process.
        try {
          opts.signal?.removeEventListener('abort', onAbort);
          if (this.active === req) this.active = null;
          const real = errors.filter((e) => !(cappedCancel && isCancelError(e)));
          if (sets.length === 0) {
            const summary = newResult(batch.text, index);
            if (affected !== undefined) summary.rowsAffected = affected;
            sets.push(summary);
          }
          if (cappedCancel) messages.push('Row cap reached; the rest of this batch was cancelled.');
          const last = sets[sets.length - 1];
          if (messages.length > 0) last.messages = messages;
          const duration = elapsedMs(started);
          for (const s of sets) s.durationMs = duration;
          if (real.length > 0) {
            // Statements after a non-fatal error may have run; keep their results with the failure.
            reject(new QueryFailure(mssqlQueryError(real[0], batch, index, real.slice(1)), sets));
            return;
          }
          resolve(sets);
        } catch (err) {
          reject(err);
        }
      });
      req.batch(batch.text, () => undefined);
    });
  }

  async fetchRows(spec: FetchRowsSpec): Promise<TablePage> {
    const started = performance.now();
    const pk = await catalog.primaryKey(this.browse, spec.schema, spec.table);
    const text = buildPageQuery('mssql', spec, pk);
    const pageReq = this.browse.request();
    pageReq.arrayRowMode = true;
    const [page, count] = await Promise.all([
      pageReq.query(text),
      spec.countTotal ? this.browse.request().query<{ total: string | number }>(buildCountQuery('mssql', spec)) : Promise.resolve(null)
    ]);
    const meta = (page as unknown as { columns?: RawColumn[][] }).columns?.[0] ?? [];
    const columns = meta.map(toColumn);
    const result = newResult(text, 0);
    result.columns = columns.map((c) => ({ name: c.name, type: mssqlTypeName(c) }));
    result.rows = (page.recordset as unknown[]).map((row) => rowCells(row).map((v, i) => mssqlValue(columns[i], v)));
    result.durationMs = elapsedMs(started);
    return { result, total: count ? Number(count.recordset[0]?.total ?? 0) : null, primaryKey: pk };
  }

  async applyChanges(schema: string, table: string, changes: RowChangeSet, opts: { preview: boolean }): Promise<ApplyChangesResult> {
    const pk = await catalog.primaryKey(this.browse, schema, table);
    const statements = buildChangeStatements('mssql', schema, table, changes, pk);
    const rendered = statements.map((s) => s.preview);
    if (opts.preview || statements.length === 0) return { statements: rendered, applied: 0 };
    const tx = new sql.Transaction(this.browse);
    try {
      // Inside the try: a begin that fails after acquiring a connection only releases it through rollback().
      await tx.begin();
      // Row counts are required to verify each edit (a server default of NOCOUNT ON would hide them).
      // Fail fast instead of hanging if the console session holds locks on these rows; both settings
      // stay on this pooled browse connection, which suits browsing too (no indefinite lock waits).
      await new sql.Request(tx).batch('SET NOCOUNT OFF; SET LOCK_TIMEOUT 15000;');
      let applied = 0;
      for (const stmt of statements) {
        const req = new sql.Request(tx);
        bind(
          req,
          stmt.params.map((p) => mssqlParam(p as Exclude<typeof p, { t: 'null' }>))
        );
        const res = await req.query(stmt.sql);
        // Trigger statements report their own counts first; the statement's own count is last.
        const count = res.rowsAffected[res.rowsAffected.length - 1] ?? 0;
        if (stmt.expectOneRow && count !== 1) throw rowMismatchError(stmt, count);
        applied += count;
      }
      await tx.commit();
      return { statements: rendered, applied };
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }
}
