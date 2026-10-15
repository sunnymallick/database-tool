/**
 * Driver contract implemented once per engine (postgres, mysql, mssql, sqlite).
 *
 * CONTRACT FILE (owned by the data layer): changes must be additive. The AI
 * slice calls `execute`, `listSchemas`, `listTables`, `describeTable`, and
 * `fetchMeta` through `ConnectionRegistry.acquire()`.
 */
import type {
  ApplyChangesResult,
  DbKind,
  DbMeta,
  QueryError,
  ResultSet,
  RoutineInfo,
  RoutineKind,
  RowChangeSet,
  SchemaList,
  SortSpec,
  TableInfo,
  TablePage,
  TableStructure
} from '@shared/types';

export interface ExecuteOptions {
  /** Max rows to materialize per result set; 0 = unlimited. Drivers stop reading (not fetch-then-truncate) where the client library allows. */
  rowCap: number;
  /** Fires when the user cancels; drivers cancel server-side where the engine supports it. */
  signal?: AbortSignal;
}

/** Thrown by `execute` when a statement fails; carries results of statements that completed first. */
export class QueryFailure extends Error {
  constructor(
    readonly error: QueryError,
    readonly partial: ResultSet[] = []
  ) {
    super(error.message);
    this.name = 'QueryFailure';
  }
}

/** How a driver is opened (additive; drivers ignore what their engine cannot do). */
export interface ConnectOptions {
  /**
   * Ask the server to refuse writes where the engine supports it (Postgres
   * `default_transaction_read_only`, MySQL `SET SESSION TRANSACTION READ ONLY`,
   * SQLite read-only open). Defense in depth: the registry's lexical guard is
   * the primary enforcement and also covers SQL Server.
   */
  readOnly?: boolean;
  /** Connect/login timeout. */
  connectTimeoutMs?: number;
}

/** Where the console session currently resolves names (it may differ from the browse connection after USE or SET search_path). */
export interface SessionContext {
  /** Schemas tried, in order, for an unqualified table name. */
  searchPath: string[];
  /** The session switched to another database (USE), so edits through the browse connection would hit a different one. */
  switchedDatabase: boolean;
}

export interface FetchRowsSpec {
  schema: string;
  table: string;
  where?: string;
  orderBy?: SortSpec[];
  limit: number;
  offset: number;
  countTotal?: boolean;
}

export interface Driver {
  readonly kind: DbKind;
  /** The database this connection is attached to (file path for SQLite). */
  readonly database: string;

  serverVersion(): Promise<string>;
  ping(): Promise<void>;
  close(): Promise<void>;

  listDatabases(): Promise<string[]>;
  listSchemas(): Promise<SchemaList>;
  listTables(schema: string): Promise<TableInfo[]>;
  listRoutines(schema: string): Promise<RoutineInfo[]>;
  describeTable(schema: string, table: string): Promise<TableStructure>;
  tableDdl(schema: string, table: string): Promise<string>;
  routineDefinition(schema: string, name: string, kind: RoutineKind): Promise<string>;

  /**
   * Run a script statement by statement on one session, returning one
   * ResultSet per statement (DML/DDL results carry `rowsAffected` and no
   * columns). Throws QueryFailure on the first failing statement.
   */
  execute(sql: string, opts: ExecuteOptions): Promise<ResultSet[]>;

  fetchRows(spec: FetchRowsSpec): Promise<TablePage>;
  /** Render (preview) or apply row edits in one transaction. */
  applyChanges(
    schema: string,
    table: string,
    changes: RowChangeSet,
    opts: { preview: boolean }
  ): Promise<ApplyChangesResult>;
  fetchMeta(opts?: { maxTables?: number }): Promise<DbMeta>;
  /** Optional: the console session's name resolution, used to decide whether a result can be edited. */
  sessionContext?(): Promise<SessionContext>;
}
