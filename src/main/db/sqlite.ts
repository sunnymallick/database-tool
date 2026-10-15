/**
 * SQLite driver (built-in node:sqlite, synchronous).
 *
 * One connection serves everything, guarded by a mutex so a paused result
 * iteration never interleaves with catalog reads or edits. Queries run on the
 * main thread; to keep the app responsive the driver yields to the event
 * loop between statements and every few thousand rows.
 *
 * Cancellation: SQLite offers no interrupt through node:sqlite, so a cancel
 * takes effect at the next yield point (between statements or row batches).
 * A single long step (a big aggregate, index build, or bulk write) runs to
 * completion.
 */
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { leadingKeyword, splitStatements, type StatementSpan } from '@shared/sql';
import type { ApplyChangesResult, ConnectionProfile, QueryError, ResultSet, RowChangeSet, TablePage } from '@shared/types';
import { AppError } from '../errors';
import * as catalog from './sqlite-catalog';
import { sqliteErrorOffset, sqliteParam, sqliteStorageClass, sqliteValue, type SqliteRaw } from './sqlite-values';
import { Mutex, cancelledFailure, elapsedMs, errorMessage, newResult, runStatements } from './common';
import { buildChangeStatements, buildCountQuery, buildPageQuery, rowMismatchError } from './dialect';
import type { ConnectOptions, Driver, ExecuteOptions, FetchRowsSpec } from './driver';

const YIELD_EVERY_ROWS = 2000;
const COUNTED = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH']);

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function sqliteQueryError(err: unknown, stmt: StatementSpan, index: number): QueryError {
  const e = (typeof err === 'object' && err ? err : {}) as { message?: string; errcode?: number; errstr?: string; code?: string };
  const error: QueryError = { message: e.message ?? errorMessage(err), statementIndex: index };
  if (e.errcode !== undefined) error.code = String(e.errcode);
  else if (e.code) error.code = e.code;
  if (e.errstr && e.errstr !== e.message) error.detail = e.errstr;
  const offset = sqliteErrorOffset(stmt.text, error.message);
  if (offset !== undefined) error.position = stmt.start + offset;
  return error;
}

export class SqliteDriver implements Driver {
  readonly kind = 'sqlite' as const;
  private readonly lock = new Mutex();

  private constructor(
    private readonly db: DatabaseSync,
    readonly database: string
  ) {}

  static async connect(profile: ConnectionProfile, _password: string | null, _database: string, opts: ConnectOptions = {}): Promise<SqliteDriver> {
    const path = expandHome(profile.filePath.trim());
    if (!path) throw new AppError('SQLite connections need a database file path', 'BAD_PROFILE');
    if (path !== ':memory:') {
      if (!existsSync(dirname(path))) throw new AppError(`Folder does not exist: ${dirname(path)}`, 'NOT_FOUND');
      if (opts.readOnly && !existsSync(path)) throw new AppError(`Database file does not exist: ${path}`, 'NOT_FOUND');
    }
    const db = new DatabaseSync(path, { readOnly: !!opts.readOnly, enableForeignKeyConstraints: true, timeout: 5000 });
    return new SqliteDriver(db, path);
  }

  private run<T>(fn: () => T): Promise<T> {
    return this.lock.run(async () => fn());
  }

  async serverVersion(): Promise<string> {
    const row = await this.run(() => this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string });
    return `SQLite ${row.v}`;
  }

  async ping(): Promise<void> {
    await this.run(() => this.db.prepare('SELECT 1').get());
  }

  async close(): Promise<void> {
    await this.lock.run(async () => {
      if (this.db.isOpen) this.db.close();
    });
  }

  async listDatabases(): Promise<string[]> {
    return [];
  }

  listSchemas() {
    return this.run(() => catalog.listSchemas(this.db));
  }

  listTables(schema: string) {
    return this.run(() => catalog.listTables(this.db, schema));
  }

  async listRoutines(): Promise<[]> {
    return [];
  }

  describeTable(schema: string, table: string) {
    return this.run(() => catalog.describeTable(this.db, schema, table));
  }

  tableDdl(schema: string, table: string) {
    return this.run(() => catalog.tableDdl(this.db, schema, table));
  }

  async routineDefinition(): Promise<string> {
    throw new AppError('SQLite has no stored procedures or functions', 'NOT_SUPPORTED');
  }

  fetchMeta(opts?: { maxTables?: number }) {
    return this.run(() => catalog.fetchMeta(this.db, opts?.maxTables ?? 2000));
  }

  execute(sql: string, opts: ExecuteOptions): Promise<ResultSet[]> {
    const statements = splitStatements(sql, 'sqlite');
    return this.lock.run(() =>
      runStatements(
        statements,
        opts,
        async (stmt, index) => {
          await yieldToEventLoop();
          if (opts.signal?.aborted) throw cancelledFailure(index, []);
          return [await this.runStatement(stmt, index, opts)];
        },
        sqliteQueryError
      )
    );
  }

  private async runStatement(stmt: StatementSpan, index: number, opts: ExecuteOptions): Promise<ResultSet> {
    const started = performance.now();
    const prepared = this.db.prepare(stmt.text);
    const declared = prepared.columns();
    if (declared.length === 0) {
      const res = prepared.run();
      const result = newResult(stmt.text, index);
      if (COUNTED.has(leadingKeyword(stmt.text, 'sqlite'))) result.rowsAffected = Number(res.changes);
      result.durationMs = elapsedMs(started);
      return result;
    }
    const { rows, truncated } = await this.readRows(prepared, opts);
    const result = this.toResult(stmt.text, index, prepared, rows);
    result.truncated = truncated;
    result.durationMs = elapsedMs(started);
    return result;
  }

  /** Iterate with the cap, yielding periodically; breaking out resets the statement. */
  private async readRows(prepared: StatementSync, opts: Pick<ExecuteOptions, 'rowCap' | 'signal'>): Promise<{ rows: SqliteRaw[][]; truncated: boolean }> {
    prepared.setReturnArrays(true);
    prepared.setReadBigInts(true);
    const rows: SqliteRaw[][] = [];
    let truncated = false;
    let sinceYield = 0;
    for (const row of prepared.iterate() as unknown as Iterable<SqliteRaw[]>) {
      if (opts.rowCap > 0 && rows.length >= opts.rowCap) {
        truncated = true;
        break;
      }
      rows.push(row);
      if (++sinceYield >= YIELD_EVERY_ROWS) {
        sinceYield = 0;
        await yieldToEventLoop();
        // runStatements turns this into a cancellation with the right statement index.
        if (opts.signal?.aborted) throw new Error('Query cancelled');
      }
    }
    return { rows, truncated };
  }

  private toResult(statement: string, index: number, prepared: StatementSync, rows: SqliteRaw[][]): ResultSet {
    const declared = prepared.columns();
    const result = newResult(statement, index);
    result.columns = declared.map((c, i) => {
      // Expressions have no declared type; report the storage class of the first value instead.
      const sample = rows.find((r) => r[i] !== null)?.[i] ?? null;
      return { name: c.name, type: c.type ?? sqliteStorageClass(sample) };
    });
    result.rows = rows.map((row) => row.map((raw, i) => sqliteValue(raw, declared[i]?.type ?? null)));
    return result;
  }

  fetchRows(spec: FetchRowsSpec): Promise<TablePage> {
    return this.lock.run(async () => {
      const started = performance.now();
      const pk = catalog.primaryKey(this.db, spec.schema, spec.table);
      const text = buildPageQuery('sqlite', spec, pk);
      const prepared = this.db.prepare(text);
      const { rows } = await this.readRows(prepared, { rowCap: 0 });
      const result = this.toResult(text, 0, prepared, rows);
      result.durationMs = elapsedMs(started);
      let total: number | null = null;
      if (spec.countTotal) total = Number((this.db.prepare(buildCountQuery('sqlite', spec)).get() as { total: number }).total);
      return { result, total, primaryKey: pk };
    });
  }

  applyChanges(schema: string, table: string, changes: RowChangeSet, opts: { preview: boolean }): Promise<ApplyChangesResult> {
    return this.run(() => {
      const pk = catalog.primaryKey(this.db, schema, table);
      const statements = buildChangeStatements('sqlite', schema, table, changes, pk);
      const rendered = statements.map((s) => s.preview);
      if (opts.preview || statements.length === 0) return { statements: rendered, applied: 0 };
      // A savepoint works both inside a transaction the console opened and on its own (where RELEASE commits).
      this.db.exec('SAVEPOINT database_tool_apply');
      try {
        let applied = 0;
        for (const stmt of statements) {
          const res = this.db.prepare(stmt.sql).run(...(stmt.params.map(sqliteParam) as SQLInputValue[]));
          const count = Number(res.changes);
          if (stmt.expectOneRow && count !== 1) throw rowMismatchError(stmt, count);
          applied += count;
        }
        this.db.exec('RELEASE database_tool_apply');
        return { statements: rendered, applied };
      } catch (err) {
        this.db.exec('ROLLBACK TO database_tool_apply');
        this.db.exec('RELEASE database_tool_apply');
        throw err;
      }
    });
  }
}
