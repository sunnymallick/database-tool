/**
 * The `db.query` pipeline: parameter substitution, row cap, cancellation by
 * query id, error normalization (engine errors come back in the response,
 * not as a rejected call), editable-result detection, and history.
 */
import { leadingKeyword, singleSelectTarget, splitStatements, substituteParametersMapped, type SubstitutedSql } from '@shared/sql';
import type { AppSettings, DbKind, EditableTarget, HistoryEntry, QueryError, QueryRequest, QueryResponse, ResultSet } from '@shared/types';
import { AppError } from '../errors';
import { resolveDatabase, type Registry } from '../connections/registry';
import type { ReadOnlyRefusal } from '../connections/guard';
import { errorMessage } from './common';
import { QueryFailure, type Driver } from './driver';

/** Result sets per script checked for in-place editability (each check may hit the catalog). */
const MAX_EDITABLE_PROBES = 10;

const MAX_ROW_CAP = 10_000_000;
const CATALOG_TTL_MS = 60_000;
const DDL_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE']);

export interface QueryRunnerDeps {
  registry: Registry;
  getSettings(): AppSettings;
  recordHistory(entry: Omit<HistoryEntry, 'id' | 'ts'>): void;
}

interface CachedKey {
  /** null: no such table in that schema. */
  pk: string[] | null;
  at: number;
}

/** `rowCap` from the request (0 = unlimited), else the settings cap. */
export function effectiveRowCap(requested: unknown, fallback: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 0) return Math.min(Math.floor(requested), MAX_ROW_CAP);
  return fallback;
}

/** Result columns name every primary-key column (exactly for Postgres, case-insensitively elsewhere). */
export function columnsCoverKey(kind: DbKind, columns: string[], pk: string[]): boolean {
  if (pk.length === 0) return false;
  const norm = (s: string) => (kind === 'postgres' ? s : s.toLowerCase());
  const names = new Set(columns.map(norm));
  return pk.every((c) => names.has(norm(c)));
}

export class QueryRunner {
  private readonly active = new Map<string, AbortController>();
  private readonly keys = new Map<string, CachedKey>();
  private readonly defaultSchemas = new Map<string, { schema: string; at: number }>();

  constructor(private readonly deps: QueryRunnerDeps) {}

  cancel(queryId: string): void {
    this.active.get(queryId)?.abort();
  }

  async run(req: QueryRequest): Promise<QueryResponse> {
    if (!req || typeof req.sql !== 'string' || typeof req.queryId !== 'string' || !req.conn || typeof req.conn.profileId !== 'string') {
      throw new AppError('Query request needs conn, sql, and queryId', 'BAD_REQUEST');
    }
    if (this.active.has(req.queryId)) throw new AppError('A query with this id is already running', 'BAD_REQUEST');
    const profile = this.deps.registry.requireProfile(req.conn.profileId);
    const database = resolveDatabase(profile, req.conn);
    const connKey = `${profile.id}\u0000${database}`;
    const controller = new AbortController();
    this.active.set(req.queryId, controller);
    const started = performance.now();

    let results: ResultSet[] = [];
    let error: QueryError | undefined;
    let sql: SubstitutedSql = { sql: req.sql, toOriginalOffset: (n) => n };
    try {
      if (req.params && Object.keys(req.params).length > 0) sql = substituteParametersMapped(req.sql, req.params, profile.kind);
      const rowCap = effectiveRowCap(req.rowCap, this.deps.getSettings().rowCap);
      const driver = await this.deps.registry.acquire(req.conn);
      try {
        results = await driver.execute(sql.sql, { rowCap, signal: controller.signal });
      } catch (err) {
        if (!(err instanceof QueryFailure)) throw err;
        results = err.partial;
        error = { ...err.error };
        if (error.position !== undefined) error.position = sql.toOriginalOffset(error.position);
      }
      if (splitStatements(sql.sql, profile.kind).some((s) => DDL_KEYWORDS.has(leadingKeyword(s.text, profile.kind)))) this.forget(connKey);
      if (!error) {
        // Each plain single-table SELECT in the script is editable on its own.
        // A lone statement uses the original text so :params don't confuse the parser.
        for (const result of results.slice(0, MAX_EDITABLE_PROBES)) {
          const text = results.length === 1 ? req.sql : result.statement;
          const editable = await this.editableTarget(driver, connKey, text, result);
          if (editable) result.editable = editable;
        }
      }
    } catch (err) {
      error = this.toQueryError(err, sql);
    } finally {
      this.active.delete(req.queryId);
    }

    const cancelled = controller.signal.aborted;
    if (cancelled) error = undefined;
    const durationMs = Math.round(performance.now() - started);
    this.deps.recordHistory({
      profileId: profile.id,
      database: database || undefined,
      connectionName: profile.name,
      sql: req.sql,
      durationMs,
      rowCount: rowCount(results),
      error: error?.message ?? (cancelled ? 'Cancelled' : undefined)
    });
    const response: QueryResponse = { results, durationMs };
    if (error) response.error = error;
    if (cancelled) response.cancelled = true;
    return response;
  }

  private toQueryError(err: unknown, sql: SubstitutedSql): QueryError {
    const error: QueryError = { message: errorMessage(err) };
    if (err instanceof AppError) {
      if (err.code) error.code = err.code;
      const refusal = err.details as Partial<ReadOnlyRefusal> | undefined;
      if (refusal && typeof refusal.position === 'number') {
        error.position = sql.toOriginalOffset(refusal.position);
        if (typeof refusal.statementIndex === 'number') error.statementIndex = refusal.statementIndex;
      }
    } else {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code === 'string') error.code = code;
    }
    return error;
  }

  private forget(connKey: string): void {
    for (const k of this.keys.keys()) if (k.startsWith(connKey)) this.keys.delete(k);
    this.defaultSchemas.delete(connKey);
  }

  private async defaultSchema(driver: Driver, connKey: string): Promise<string> {
    if (driver.kind === 'sqlite') return 'main';
    if (driver.kind === 'mysql' && driver.database) return driver.database;
    const hit = this.defaultSchemas.get(connKey);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.schema;
    const schema = (await driver.listSchemas()).defaultSchema;
    this.defaultSchemas.set(connKey, { schema, at: Date.now() });
    return schema;
  }

  /** The table's primary key, or null when the schema has no such table. */
  private async primaryKey(driver: Driver, connKey: string, schema: string, table: string): Promise<string[] | null> {
    const key = `${connKey}\u0000${schema}\u0000${table}`;
    const hit = this.keys.get(key);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.pk;
    let pk: string[] | null;
    try {
      pk = (await driver.describeTable(schema, table)).primaryKey;
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'NOT_FOUND')) throw err;
      pk = null;
    }
    this.keys.set(key, { pk, at: Date.now() });
    return pk;
  }

  /**
   * A result is editable when the query is a plain single-table SELECT and its
   * columns include the whole primary key. Lookup failures just mean "not editable".
   */
  private async editableTarget(driver: Driver, connKey: string, sql: string, result: ResultSet): Promise<EditableTarget | undefined> {
    if (result.columns.length === 0) return undefined;
    const target = singleSelectTarget(sql, driver.kind);
    if (!target) return undefined;
    try {
      // Resolve names the way the console session does (USE, SET search_path), not the browse connection.
      const ctx = driver.sessionContext ? await driver.sessionContext() : undefined;
      // Edits run on the browse connection; after a console USE they would reach a different database.
      if (ctx?.switchedDatabase) return undefined;
      const schemas = target.schema ? [target.schema] : ctx?.searchPath.length ? ctx.searchPath : [await this.defaultSchema(driver, connKey)];
      for (const schema of schemas) {
        const pk = await this.primaryKey(driver, connKey, schema, target.table);
        if (pk === null) continue;
        if (!columnsCoverKey(driver.kind, result.columns.map((c) => c.name), pk)) return undefined;
        return { schema, table: target.table, primaryKey: pk };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}

function rowCount(results: ResultSet[]): number | undefined {
  const sets = results.filter((r) => r.columns.length > 0);
  if (sets.length > 0) return sets.reduce((n, r) => n + r.rows.length, 0);
  const affected = results.filter((r) => r.rowsAffected !== undefined);
  return affected.length > 0 ? affected.reduce((n, r) => n + (r.rowsAffected ?? 0), 0) : undefined;
}
