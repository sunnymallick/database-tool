/**
 * The database tools the agent can call, independent of the Agent SDK so
 * they can be unit-tested with a fake registry. `agent-sdk.ts` wraps each
 * spec with the SDK's `tool()` helper.
 *
 * Every handler returns a ToolOutput; failures become error content for the
 * model and never throw out of the turn.
 */
import { z } from 'zod/v4';
import { AI_TOOL_KINDS, type AiToolKind, type AiToolName, type EditorSnapshot } from '@shared/ai';
import { isReadOnlyScript, splitStatements } from '@shared/sql';
import type { ConnRef, ConnectionProfile, ResultSet, Value } from '@shared/types';
import { valueToJson } from '@shared/values';
import { QueryFailure, type Driver } from '../db/driver';
import type { ConnectionRegistry } from '../services';
import { writePolicy, type WriteGrants } from './approvals';

/** Rows returned to the model per result set (like dbTool's encode_result). */
export const MAX_ROWS = 100;
/** Hard cap on one tool result, in UTF-8 bytes. */
export const MAX_PAYLOAD_BYTES = 50_000;
/** Long cell values are cut to this many characters. */
export const MAX_CELL_CHARS = 2_000;
/** Editor SQL handed to the model by read_editor. */
export const MAX_EDITOR_CHARS = 40_000;
const MAX_TABLES_LISTED = 1_000;
const SELECT_TIMEOUT_MS = 60_000;

export interface ToolOutput {
  text: string;
  isError: boolean;
}

export interface ToolContext {
  registry: ConnectionRegistry;
  conn: ConnRef | null;
  profile: ConnectionProfile | null;
  editor: EditorSnapshot | null;
  allowWrites: boolean;
  grants: WriteGrants;
  /** Aborts when the turn is cancelled. */
  signal: AbortSignal;
  /** Audit trail for statements the agent ran. */
  recordHistory?: (sql: string, result: { durationMs: number; rowCount?: number; error?: string }) => void;
}

// ---------------------------------------------------------------------------
// Tool specs (names, descriptions, schemas) shared by the SDK wrapper
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: AiToolName;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'list_schemas',
    description:
      'List the schemas (namespaces) in the selected database and which one is the default. ' +
      'For MySQL the namespace level is the database.',
    shape: {},
    readOnly: true
  },
  {
    name: 'list_tables',
    description:
      'List tables and views in one schema of the selected database, with row estimates when the engine has them. ' +
      'Omit `schema` for the default schema.',
    shape: { schema: z.string().optional().describe('Schema name; omit for the default schema.') },
    readOnly: true
  },
  {
    name: 'describe_table',
    description:
      'Describe one table or view: columns (type, nullability, default, primary key), indexes, foreign keys in both ' +
      'directions, and check constraints. Use it before writing SQL against a table you have not inspected.',
    shape: {
      table: z.string().describe('Table or view name, without quotes.'),
      schema: z.string().optional().describe('Schema name; omit for the default schema.')
    },
    readOnly: true
  },
  {
    name: 'run_select',
    description:
      'Run ONE read-only statement (SELECT, WITH ... SELECT, EXPLAIN, SHOW, DESCRIBE, PRAGMA reads) against the ' +
      `selected database and get the columns plus up to ${MAX_ROWS} rows as JSON (rows are arrays in column order). ` +
      'Use it to check facts before answering. Keep results small: aggregate, filter, and add LIMIT/TOP. ' +
      'Writes are rejected here; use run_statement for writes.',
    shape: { sql: z.string().describe('Exactly one read-only SQL statement in the engine dialect.') },
    readOnly: true
  },
  {
    name: 'run_statement',
    description:
      'Execute ONE statement that changes data or schema (INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, ...) ' +
      'against the selected database. The user usually has to approve each call in the app before it runs, and ' +
      'read-only connections refuse it. Only use it when the user asked you to make the change; when they want SQL ' +
      'to run themselves, use propose_sql instead. Returns rows_affected (and any rows the statement returns).',
    shape: { sql: z.string().describe('Exactly one SQL statement in the engine dialect.') },
    readOnly: false
  },
  {
    name: 'read_editor',
    description:
      "Read the SQL in the user's active query editor tab (title, full SQL, current selection, and its connection). " +
      'Use it whenever the user refers to "this query", "my query", or the editor.',
    shape: {},
    readOnly: true
  },
  {
    name: 'propose_sql',
    description:
      'Show SQL to the user WITHOUT running it. It appears as a card with Copy, Open in new tab, Replace editor, and ' +
      'Insert at cursor actions. Use it to hand back a query the user wants to run or edit themselves, or a revised ' +
      'version of their editor query. Never execute a statement just to display it.',
    shape: {
      sql: z.string().describe('The complete SQL to show, formatted for readability.'),
      explanation: z.string().optional().describe('One or two sentences on what the SQL does.')
    },
    readOnly: true
  }
];

// ---------------------------------------------------------------------------
// Result encoding
// ---------------------------------------------------------------------------

function truncateText(s: string, max = MAX_CELL_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

/** JSON for one cell, with long text and large binaries cut down. */
export function cellToJson(v: Value): unknown {
  switch (v.t) {
    case 'text':
    case 'decimal':
    case 'datetime':
      return truncateText(v.v);
    case 'bytes':
      return v.length <= 32 && !v.truncated ? `\\x${v.hex}` : `<${v.length} bytes>`;
    case 'json': {
      const s = typeof v.v === 'string' ? v.v : JSON.stringify(v.v);
      return s.length > MAX_CELL_CHARS ? truncateText(s) : v.v;
    }
    default:
      return valueToJson(v);
  }
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Largest n in [0, total] for which build(n) serializes within maxBytes (build is monotonic in n). */
function fitCount(total: number, maxBytes: number, build: (n: number) => unknown): number {
  if (byteLength(JSON.stringify(build(total))) <= maxBytes) return total;
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(JSON.stringify(build(mid))) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface EncodeOptions {
  maxRows?: number;
  maxBytes?: number;
}

/** A result set as the model sees it: at most maxRows rows and maxBytes bytes. */
export function encodeResult(rs: ResultSet, opts: EncodeOptions = {}): Record<string, unknown> {
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const columns = rs.columns.map((c) => ({ name: c.name, type: c.type }));
  const rows = rs.rows.slice(0, maxRows).map((r) => r.map(cellToJson));
  const moreRowsExist = rs.truncated || rs.rows.length > maxRows;

  const build = (n: number): Record<string, unknown> => {
    const out: Record<string, unknown> = { columns, rows: rows.slice(0, n), row_count: n };
    if (rs.rowsAffected !== undefined && rs.rowsAffected !== null) out.rows_affected = rs.rowsAffected;
    const cut = n < rows.length;
    if (moreRowsExist || cut) {
      out.truncated = true;
      out.note = cut
        ? `Only the first ${n} rows fit in the ${maxBytes}-byte result limit. Select fewer columns, aggregate, or add a LIMIT.`
        : `More rows exist; only the first ${n} are shown. Aggregate or filter instead of paging through rows.`;
    }
    if (rs.messages?.length) out.messages = rs.messages.slice(0, 20).map((m) => truncateText(m, 500));
    return out;
  };

  const n = fitCount(rows.length, maxBytes, build);
  const payload = build(n);
  if (n === 0 && rows.length > 0 && byteLength(JSON.stringify(payload)) > maxBytes) {
    return {
      columns: columns.slice(0, 200),
      row_count: 0,
      truncated: true,
      note: `The result is wider than the ${maxBytes}-byte limit. Select fewer columns.`
    };
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Tool host
// ---------------------------------------------------------------------------

const ok = (payload: unknown): ToolOutput => ({ text: JSON.stringify(payload), isError: false });
const fail = (message: string, extra?: Record<string, unknown>): ToolOutput => ({
  text: JSON.stringify({ error: message, ...extra }),
  isError: true
});

function failureFromError(err: unknown): ToolOutput {
  if (err instanceof QueryFailure) {
    const e = err.error;
    const extra: Record<string, unknown> = {};
    if (e.code) extra.code = e.code;
    if (e.detail) extra.detail = truncateText(e.detail, 1000);
    if (e.hint) extra.hint = truncateText(e.hint, 1000);
    if (e.position !== undefined) extra.position = e.position;
    return fail(truncateText(e.message, 2000), extra);
  }
  if (err instanceof Error && err.name === 'AbortError') return fail('Cancelled by the user.');
  return fail(truncateText(err instanceof Error ? err.message : String(err), 2000));
}

function sqlArg(input: unknown): string {
  const v = (input as { sql?: unknown } | null)?.sql;
  return typeof v === 'string' ? v : '';
}

export interface CallInfo {
  kind: AiToolKind;
  preview: string;
  needsApproval: boolean;
  production: boolean;
}

export class ToolHost {
  private driverPromise: Promise<Driver> | null = null;

  constructor(private readonly ctx: ToolContext) {}

  get profile(): ConnectionProfile | null {
    return this.ctx.profile;
  }

  /** What the UI shows for a call, and whether it must wait for approval. */
  describeCall(name: string, input: unknown): CallInfo {
    const known = (AI_TOOL_KINDS as Record<string, AiToolKind | undefined>)[name];
    const kind = known ?? 'read';
    const production = !!this.ctx.profile?.production;
    const args = (input ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
    let preview: string;
    switch (name) {
      case 'run_select':
      case 'run_statement':
      case 'propose_sql':
        preview = sqlArg(input);
        break;
      case 'list_tables':
        preview = str('schema') || '(default schema)';
        break;
      case 'describe_table':
        preview = str('schema') ? `${str('schema')}.${str('table')}` : str('table');
        break;
      case 'read_editor':
        preview = this.ctx.editor ? this.ctx.editor.title : '(no editor shared)';
        break;
      case 'list_schemas':
        preview = '';
        break;
      default:
        preview = JSON.stringify(input ?? {});
    }
    const needsApproval = name === 'run_statement' && writePolicy(this.ctx.profile, this.ctx.allowWrites).policy === 'ask';
    return { kind, preview, needsApproval, production };
  }

  /** Dispatch by tool name. Never throws. */
  async call(name: string, input: unknown): Promise<ToolOutput> {
    const args = (input ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'list_schemas':
          return await this.listSchemas();
        case 'list_tables':
          return await this.listTables(typeof args.schema === 'string' ? args.schema : undefined);
        case 'describe_table':
          return await this.describeTable(
            typeof args.table === 'string' ? args.table : '',
            typeof args.schema === 'string' ? args.schema : undefined
          );
        case 'run_select':
          return await this.runSelect(sqlArg(input));
        case 'run_statement':
          return await this.runStatement(sqlArg(input));
        case 'read_editor':
          return this.readEditor();
        case 'propose_sql':
          return this.proposeSql(sqlArg(input), typeof args.explanation === 'string' ? args.explanation : undefined);
        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return failureFromError(err);
    }
  }

  private async driver(): Promise<Driver> {
    if (!this.ctx.conn || !this.ctx.profile) {
      throw new Error('No database is selected in the AI panel. Ask the user to pick a connection there.');
    }
    if (!this.driverPromise) {
      const p = this.ctx.registry.acquire(this.ctx.conn);
      this.driverPromise = p;
      p.catch(() => {
        if (this.driverPromise === p) this.driverPromise = null;
      });
    }
    return this.driverPromise;
  }

  private async defaultSchema(d: Driver): Promise<string> {
    return (await d.listSchemas()).defaultSchema;
  }

  async listSchemas(): Promise<ToolOutput> {
    const d = await this.driver();
    const list = await d.listSchemas();
    const n = fitCount(list.schemas.length, MAX_PAYLOAD_BYTES, (k) => list.schemas.slice(0, k));
    return ok({
      default_schema: list.defaultSchema,
      schemas: list.schemas.slice(0, n),
      ...(n < list.schemas.length ? { truncated: true, total: list.schemas.length } : {})
    });
  }

  async listTables(schema?: string): Promise<ToolOutput> {
    const d = await this.driver();
    const target = schema?.trim() || (await this.defaultSchema(d));
    const tables = await d.listTables(target);
    const entries = tables.slice(0, MAX_TABLES_LISTED).map((t) => {
      const e: Record<string, unknown> = { name: t.name };
      if (t.kind !== 'table') e.kind = t.kind;
      if (t.rowEstimate !== undefined && t.rowEstimate !== null) e.rows = t.rowEstimate;
      if (t.comment) e.comment = truncateText(t.comment, 200);
      return e;
    });
    const build = (k: number) => ({ schema: target, tables: entries.slice(0, k), count: tables.length });
    const n = fitCount(entries.length, MAX_PAYLOAD_BYTES, build);
    return ok({ ...build(n), ...(n < tables.length ? { truncated: true } : {}) });
  }

  async describeTable(table: string, schema?: string): Promise<ToolOutput> {
    if (!table.trim()) return fail('`table` is required.');
    const d = await this.driver();
    const target = schema?.trim() || (await this.defaultSchema(d));
    const s = await d.describeTable(target, table.trim());
    const fk = (f: (typeof s.foreignKeys)[number]) => ({
      name: f.name,
      columns: f.columns,
      table: `${f.schema}.${f.table}`,
      references: `${f.refSchema}.${f.refTable}(${f.refColumns.join(', ')})`,
      ...(f.onDelete ? { on_delete: f.onDelete } : {})
    });
    const payload: Record<string, unknown> = {
      schema: s.schema,
      name: s.name,
      kind: s.kind,
      columns: s.columns.map((c) => {
        const col: Record<string, unknown> = { name: c.name, type: c.type, nullable: c.nullable };
        if (c.isPrimaryKey) col.pk = true;
        if (c.isIdentity) col.identity = true;
        if (c.isGenerated) col.generated = true;
        if (c.defaultValue !== null && c.defaultValue !== undefined) col.default = truncateText(c.defaultValue, 200);
        if (c.comment) col.comment = truncateText(c.comment, 300);
        return col;
      }),
      primary_key: s.primaryKey,
      indexes: s.indexes.map((i) => ({ name: i.name, columns: i.columns, ...(i.unique ? { unique: true } : {}) })),
      foreign_keys: s.foreignKeys.map(fk),
      referenced_by: s.referencedBy.map(fk),
      checks: s.checks.map((c) => ({ name: c.name, definition: truncateText(c.definition, 500) }))
    };
    if (s.comment) payload.comment = truncateText(s.comment, 500);
    if (s.rowEstimate !== undefined && s.rowEstimate !== null) payload.row_estimate = s.rowEstimate;
    const text = JSON.stringify(payload);
    if (byteLength(text) > MAX_PAYLOAD_BYTES) {
      payload.indexes = (payload.indexes as unknown[]).slice(0, 20);
      payload.referenced_by = (payload.referenced_by as unknown[]).slice(0, 20);
      payload.columns = (payload.columns as unknown[]).slice(0, 300);
      payload.truncated = true;
    }
    return ok(payload);
  }

  /** Validate that `sql` is exactly one statement. Returns the statement text or an error. */
  private singleStatement(sql: string, tool: string): { text: string } | { error: ToolOutput } {
    if (!sql.trim()) return { error: fail('`sql` is required.') };
    const stmts = splitStatements(sql, this.ctx.profile?.kind);
    if (stmts.length === 0) return { error: fail('The SQL contains no statement (only whitespace or comments).') };
    if (stmts.length > 1) {
      return { error: fail(`${tool} runs exactly one statement, but this SQL has ${stmts.length}. Send them one call at a time.`) };
    }
    return { text: sql };
  }

  async runSelect(sql: string): Promise<ToolOutput> {
    const one = this.singleStatement(sql, 'run_select');
    if ('error' in one) return one.error;
    if (!isReadOnlyScript(sql, this.ctx.profile?.kind)) {
      return fail(
        'run_select only accepts read-only statements (SELECT, WITH ... SELECT, EXPLAIN, SHOW, DESCRIBE). ' +
          'Use run_statement for changes the user asked you to make, or propose_sql to hand the SQL to the user.'
      );
    }
    const d = await this.driver();
    const signal = AbortSignal.any([this.ctx.signal, AbortSignal.timeout(SELECT_TIMEOUT_MS)]);
    const results = await d.execute(sql, { rowCap: MAX_ROWS, signal });
    const rs = results[0];
    if (!rs) return ok({ columns: [], rows: [], row_count: 0 });
    return ok(encodeResult(rs));
  }

  async runStatement(sql: string): Promise<ToolOutput> {
    const decision = writePolicy(this.ctx.profile, this.ctx.allowWrites);
    if (decision.policy === 'refuse') return fail(decision.reason);
    const one = this.singleStatement(sql, 'run_statement');
    if ('error' in one) return one.error;
    if (decision.policy === 'ask' && !this.ctx.grants.consume(sql)) {
      return fail('This statement was not approved by the user, so it did not run.');
    }
    const d = await this.driver();
    const started = Date.now();
    try {
      const results = await d.execute(sql, { rowCap: MAX_ROWS, signal: this.ctx.signal });
      const rs = results[0];
      const affected = results.reduce((n, r) => n + (r.rowsAffected ?? 0), 0);
      this.ctx.recordHistory?.(sql, { durationMs: Date.now() - started, rowCount: affected });
      if (!rs) return ok({ rows_affected: 0 });
      if (rs.columns.length === 0) return ok({ rows_affected: rs.rowsAffected ?? affected });
      return ok(encodeResult(rs));
    } catch (err) {
      this.ctx.recordHistory?.(sql, {
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }

  readEditor(): ToolOutput {
    const e = this.ctx.editor;
    if (!e) {
      return fail(
        'The user did not share an editor with this message (no query tab is focused, or "include editor" is off). ' +
          'Ask them to focus the query tab and turn on "Include editor".'
      );
    }
    const conn = e.conn ? this.ctx.registry.getProfile(e.conn.profileId) : undefined;
    return ok({
      title: e.title,
      connection: conn ? `${conn.name}${e.conn?.database ? ` / ${e.conn.database}` : ''}` : null,
      sql: truncateText(e.sql, MAX_EDITOR_CHARS),
      selection: e.selection ? truncateText(e.selection, MAX_EDITOR_CHARS) : null
    });
  }

  proposeSql(sql: string, _explanation?: string): ToolOutput {
    if (!sql.trim()) return fail('`sql` is required.');
    return ok({
      shown: true,
      executed: false,
      note: 'The SQL is shown to the user as a card with Copy, Open in new tab, Replace editor, and Insert at cursor actions. It was not run.'
    });
  }
}

/** Short text for a tool card, built from the tool's JSON output. */
export function summarizeToolOutput(name: string, text: string, isError: boolean): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
  } catch {
    // not JSON (e.g. a permission denial message)
  }
  if (isError) {
    const msg = typeof parsed?.error === 'string' ? parsed.error : text;
    return clip(msg.replace(/^Error:\s*/, ''));
  }
  if (!parsed) return clip(text);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  switch (name) {
    case 'list_schemas':
      return Array.isArray(parsed.schemas) ? plural(parsed.schemas.length, 'schema') : 'Done';
    case 'list_tables': {
      const count = typeof parsed.count === 'number' ? parsed.count : Array.isArray(parsed.tables) ? parsed.tables.length : 0;
      return `${plural(count, 'table')} in ${String(parsed.schema ?? '')}`;
    }
    case 'describe_table':
      return Array.isArray(parsed.columns) ? `${plural(parsed.columns.length, 'column')}` : 'Done';
    case 'run_select':
    case 'run_statement': {
      const parts: string[] = [];
      if (typeof parsed.rows_affected === 'number') parts.push(plural(parsed.rows_affected, 'row') + ' affected');
      if (Array.isArray(parsed.columns) && typeof parsed.row_count === 'number' && parsed.columns.length > 0) {
        parts.push(plural(parsed.row_count, 'row') + (parsed.truncated ? ' (truncated)' : ''));
      }
      return parts.join(', ') || 'Done';
    }
    case 'read_editor':
      return `Read "${String(parsed.title ?? 'editor')}"`;
    case 'propose_sql':
      return 'Shown to the user';
    default:
      return 'Done';
  }
}

function clip(s: string, max = 240): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
