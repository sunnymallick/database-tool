/**
 * Shared data model used by the main process (drivers, persistence) and the
 * renderer (UI). Everything here must survive Electron's structured clone, so
 * it is plain data: no classes, functions, or Dates.
 *
 * CONTRACT FILE: changes must be additive and backward compatible.
 */

export type DbKind = 'postgres' | 'mysql' | 'mssql' | 'sqlite';

export interface DbKindInfo {
  kind: DbKind;
  label: string;
  defaultPort: number;
  /** SQLite: a file path instead of host/port/user. */
  fileBased: boolean;
  /** Name the engine uses for the namespace level below a database. */
  schemaLabel: string;
  defaultSchema: string;
}

export const DB_KINDS: readonly DbKindInfo[] = [
  { kind: 'postgres', label: 'PostgreSQL', defaultPort: 5432, fileBased: false, schemaLabel: 'Schema', defaultSchema: 'public' },
  { kind: 'mysql', label: 'MySQL', defaultPort: 3306, fileBased: false, schemaLabel: 'Database', defaultSchema: '' },
  { kind: 'mssql', label: 'SQL Server', defaultPort: 1433, fileBased: false, schemaLabel: 'Schema', defaultSchema: 'dbo' },
  { kind: 'sqlite', label: 'SQLite', defaultPort: 0, fileBased: true, schemaLabel: 'Schema', defaultSchema: 'main' }
] as const;

export function dbKindInfo(kind: DbKind): DbKindInfo {
  const info = DB_KINDS.find((k) => k.kind === kind);
  if (!info) throw new Error(`unknown database kind: ${kind}`);
  return info;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface ConnectionProfile {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  /** Default database to open. Ignored for SQLite. */
  database: string;
  username: string;
  /** SQLite database file. Empty for server engines. */
  filePath: string;
  /** Postgres/MySQL: require TLS. SQL Server: `encrypt`. */
  ssl: boolean;
  /** Accept self-signed server certificates (SQL Server `trustServerCertificate`, pg/mysql `rejectUnauthorized: false`). */
  trustServerCertificate: boolean;
  /**
   * Engine-specific extras. Known keys:
   *  - mssql: `instanceName`, `applicationName`, `domain`
   *  - all:   `connectTimeoutSec`
   */
  options: Record<string, string>;
  /** Additional databases on the same server shown as their own sidebar nodes (each is its own connection). */
  extraDatabases: string[];
  /** Accent color as `#rrggbb`, or null for none. */
  color: string | null;
  /** Optional sidebar folder. */
  group: string | null;
  /** Red-tinted UI and extra confirmation before writes. */
  production: boolean;
  /** Refuse every statement that can write (enforced in the main process). */
  readOnly: boolean;
  /** Derived on read: a password is stored for this profile. Ignored on save. */
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A live connection target: a profile plus (optionally) one of its databases. */
export interface ConnRef {
  profileId: string;
  /** Database to use; undefined means the profile's default database. Ignored for SQLite. */
  database?: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionStatus {
  profileId: string;
  /** Resolved database name (the profile default when the ref omitted it). */
  database: string;
  state: ConnectionState;
  error?: string;
  serverVersion?: string;
  connectedAt?: string;
}

export interface SaveConnectionRequest {
  profile: ConnectionProfile;
  /** undefined: keep the stored password. null: delete it. string: store it. */
  password?: string | null;
}

export interface TestConnectionRequest {
  profile: ConnectionProfile;
  /** undefined: use the stored password for profile.id, if any. */
  password?: string | null;
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
  latencyMs?: number;
}

export interface ImportDbtoolRequest {
  /** Also copy passwords from dbTool's macOS Keychain entries. macOS will prompt for permission. */
  includePasswords: boolean;
}

export interface ImportResult {
  imported: ConnectionProfile[];
  skipped: { name: string; reason: string }[];
  passwordsImported: number;
  sourcePath: string;
  /** Imported with caveats (e.g. the profile used an SSH tunnel), or Keychain reads that were denied. */
  warnings?: { name: string; message: string }[];
}

// ---------------------------------------------------------------------------
// Values and result sets
// ---------------------------------------------------------------------------

/**
 * One cell value. Tagged so the UI can render, align, and edit by type and so
 * 64-bit integers and exact decimals survive transport as text.
 */
export type Value =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  /** Integer as decimal text (int64/bigint safe). */
  | { t: 'int'; v: string }
  | { t: 'float'; v: number }
  /** NUMERIC / DECIMAL / MONEY as exact text. */
  | { t: 'decimal'; v: string }
  | { t: 'text'; v: string }
  /** Binary as lowercase hex (no prefix). `length` is the full byte length; hex may be cut short when `truncated`. */
  | { t: 'bytes'; hex: string; length: number; truncated?: boolean }
  /** JSON/JSONB and array-like values, parsed. */
  | { t: 'json'; v: unknown }
  /** Dates, times, timestamps as the server renders them (ISO-like text, never a JS Date). */
  | { t: 'datetime'; v: string };

export interface ResultColumn {
  name: string;
  /** Database type name as reported by the driver, e.g. `int4`, `varchar`, `nvarchar`, `TEXT`. */
  type: string;
}

/** A query result that maps 1:1 onto rows of one table, so cells can be edited in place. */
export interface EditableTarget {
  schema: string;
  table: string;
  primaryKey: string[];
}

export interface ResultSet {
  columns: ResultColumn[];
  rows: Value[][];
  /** Rows changed by INSERT/UPDATE/DELETE/etc. */
  rowsAffected?: number;
  /** The row cap cut this result short. */
  truncated: boolean;
  /** SQL text of the statement that produced this result. */
  statement: string;
  /** Index of that statement within the submitted script. */
  statementIndex: number;
  durationMs: number;
  editable?: EditableTarget;
  /** Server notices, PRINT output, warnings. */
  messages?: string[];
}

export interface QueryRequest {
  conn: ConnRef;
  sql: string;
  /** Client-generated id; pass it to `db.cancel` to abort. */
  queryId: string;
  /** Overrides the settings row cap. 0 = unlimited ("fetch all"). */
  rowCap?: number;
  /** Values for `:name` parameters, substituted as SQL literals before execution. */
  params?: Record<string, string>;
}

export interface QueryError {
  message: string;
  /** Engine error code (SQLSTATE, MySQL errno, MSSQL number). */
  code?: string;
  /** Which statement of the script failed. */
  statementIndex?: number;
  /** 0-based character offset into the submitted SQL, when the engine reports one. */
  position?: number;
  detail?: string;
  hint?: string;
}

export interface QueryResponse {
  /** Results of every statement that completed (also on error: statements before the failing one). */
  results: ResultSet[];
  durationMs: number;
  error?: QueryError;
  cancelled?: boolean;
}

// ---------------------------------------------------------------------------
// Schema objects
// ---------------------------------------------------------------------------

export type TableKind = 'table' | 'view' | 'materialized_view';

export interface SchemaList {
  schemas: string[];
  defaultSchema: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: TableKind;
  comment?: string;
  rowEstimate?: number;
}

export type RoutineKind = 'function' | 'procedure';

export interface RoutineInfo {
  schema: string;
  name: string;
  kind: RoutineKind;
  /** Argument list, display only. */
  signature?: string;
  returns?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  isGenerated?: boolean;
  comment?: string;
  /** 1-based position. */
  ordinal: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method?: string;
  definition?: string;
}

export interface ForeignKeyInfo {
  name: string;
  /** Owning table (useful for incoming references). */
  schema: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

export interface CheckInfo {
  name: string;
  definition: string;
}

export interface TableStructure {
  schema: string;
  name: string;
  kind: TableKind;
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: IndexInfo[];
  /** Outgoing foreign keys. */
  foreignKeys: ForeignKeyInfo[];
  /** Incoming foreign keys from other tables. */
  referencedBy: ForeignKeyInfo[];
  checks: CheckInfo[];
  comment?: string;
  rowEstimate?: number;
}

export interface TableRef {
  conn: ConnRef;
  schema: string;
  table: string;
}

/** Compact catalog for editor completion and the AI system prompt. */
export interface DbMeta {
  defaultSchema: string;
  schemas: string[];
  tables: {
    schema: string;
    name: string;
    kind: TableKind;
    columns: { name: string; type: string }[];
  }[];
  /** The catalog was larger than the cap and was cut short. */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Table data paging and editing
// ---------------------------------------------------------------------------

export interface SortSpec {
  column: string;
  desc: boolean;
}

export interface FetchRowsRequest {
  table: TableRef;
  /** Raw WHERE body typed by the user (no `WHERE` keyword), passed through verbatim. */
  where?: string;
  orderBy?: SortSpec[];
  limit: number;
  offset: number;
  /** Also run COUNT(*) with the same filter. */
  countTotal?: boolean;
}

export interface TablePage {
  result: ResultSet;
  /** COUNT(*) with the filter, or null when not requested. */
  total: number | null;
  primaryKey: string[];
}

export interface RowUpdate {
  /** Primary key column -> original value. */
  pk: Record<string, Value>;
  /** Column -> new value. */
  set: Record<string, Value>;
}

export interface RowChangeSet {
  updates: RowUpdate[];
  /** Column -> value; omitted columns take their database default. */
  inserts: Record<string, Value>[];
  /** Primary key maps of rows to delete. */
  deletes: Record<string, Value>[];
}

export interface ApplyChangesRequest {
  table: TableRef;
  changes: RowChangeSet;
  /** true: only render the SQL that would run; nothing is executed. */
  preview: boolean;
}

export interface ApplyChangesResult {
  /** Rendered SQL (with literals) in execution order. */
  statements: string[];
  /** Total rows affected; 0 for a preview. */
  applied: number;
}

// ---------------------------------------------------------------------------
// Workspace persistence
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  /** ISO timestamp. */
  ts: string;
  profileId: string;
  database?: string;
  connectionName: string;
  sql: string;
  durationMs?: number;
  rowCount?: number;
  error?: string;
}

export interface HistoryQuery {
  limit?: number;
  search?: string;
  profileId?: string;
}

export interface Snippet {
  id: string;
  name: string;
  sql: string;
  description?: string;
  updatedAt: string;
}

export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppSettings {
  theme: ThemeMode;
  editorFontSize: number;
  editorLineNumbers: boolean;
  editorWordWrap: boolean;
  /** Editor results stop materializing rows past this cap; the grid offers "fetch all". */
  rowCap: number;
  /** Rows per page in table data tabs. */
  pageSize: number;
  /** Ask before running write statements against production profiles. */
  confirmProductionWrites: boolean;
  /** Claude model id used by the AI panel. */
  aiModel: string;
  /** Let the agent run write statements without per-call approval (never applies to production profiles). */
  aiAllowWrites: boolean;
  /** Full path to the `claude` CLI; empty = auto-detect. */
  claudeCliPath: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  editorFontSize: 13,
  editorLineNumbers: true,
  editorWordWrap: false,
  rowCap: 5000,
  pageSize: 200,
  confirmProductionWrites: true,
  aiModel: 'claude-opus-5-5',
  aiAllowWrites: false,
  claudeCliPath: ''
};

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  /** Where profiles, history, snippets, settings, and session are stored. */
  dataDir: string;
}

// ---------------------------------------------------------------------------
// Files and dialogs
// ---------------------------------------------------------------------------

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileRequest {
  title?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  defaultPath?: string;
}

export interface SaveFileRequest {
  title?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  defaultPath?: string;
}

export interface TextFile {
  path: string;
  content: string;
}

export interface OpenDirectoryRequest {
  title?: string;
  defaultPath?: string;
  /** Label for the confirm button, e.g. "Export Here". */
  buttonLabel?: string;
}

export interface BinaryFile {
  path: string;
  data: Uint8Array;
}

export interface WriteToDirectoryRequest {
  /** A folder returned by `dialog.openDirectory` this session. */
  dir: string;
  /** Bare file names (no folders). Existing files are never overwritten: a " (2)" suffix is added instead. */
  files: { name: string; content: string | Uint8Array }[];
}

/** Actions triggered from the native application menu. */
export type MenuAction =
  | 'new-query'
  | 'new-connection'
  | 'open-sql-file'
  | 'save-sql-file'
  | 'save-sql-file-as'
  | 'close-tab'
  | 'toggle-sidebar'
  | 'toggle-ai'
  | 'open-settings'
  | 'show-shortcuts'
  | 'command-palette'
  | 'run-query'
  | 'format-sql';
