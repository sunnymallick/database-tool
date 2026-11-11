/**
 * The read-only tools Claude Code gets through the db-tool MCP server. Each
 * call names its connection; handlers reuse the in-app agent's ToolHost (same
 * row/byte caps, result encoding, and single-statement checks) against a
 * registry that only holds exposed, read-only profiles.
 *
 * There is deliberately no write tool.
 */
import { z } from 'zod/v4';
import { MAX_PAYLOAD_BYTES, MAX_ROWS, ToolHost, failureFromError, type ToolOutput } from '../ai/tools';
import { WriteGrants } from '../ai/approvals';
import { allowedDatabases, externalReadRefusal } from './access';
import { appendAudit } from './audit';
import type { ExternalServices, Target } from './services';

export interface ExternalToolSpec {
  name: string;
  description: string;
  shape: z.ZodRawShape;
}

const connection = z
  .string()
  .describe('Connection name (or id) exactly as list_connections shows it.');
const database = z
  .string()
  .optional()
  .describe("Database on that server; omit for the connection's default. Must be one list_connections shows.");

export const EXTERNAL_TOOL_SPECS: readonly ExternalToolSpec[] = [
  {
    name: 'list_connections',
    description:
      'List the database connections the user shared with Claude Code in Database Tool: name, engine, default ' +
      'database, other databases, and whether it is production. Every connection here is read-only. Call this first.',
    shape: {}
  },
  {
    name: 'list_schemas',
    description: 'List the schemas (namespaces) in a database and which one is the default. For MySQL the namespace is the database.',
    shape: { connection, database }
  },
  {
    name: 'list_tables',
    description: 'List tables and views in one schema, with row estimates when the engine has them. Omit `schema` for the default.',
    shape: { connection, database, schema: z.string().optional().describe('Schema name; omit for the default schema.') }
  },
  {
    name: 'describe_table',
    description:
      'Describe a table or view: columns (type, nullability, default, primary key), indexes, foreign keys in both ' +
      'directions, and check constraints. Use it before writing SQL or code against a table.',
    shape: {
      connection,
      database,
      table: z.string().describe('Table or view name, without the schema.'),
      schema: z.string().optional().describe('Schema name; omit for the default schema.')
    }
  },
  {
    name: 'table_ddl',
    description: 'Get the CREATE statement for a table or view (as the database tool renders it). Handy when writing migrations.',
    shape: {
      connection,
      database,
      table: z.string().describe('Table or view name, without the schema.'),
      schema: z.string().optional().describe('Schema name; omit for the default schema.')
    }
  },
  {
    name: 'run_select',
    description:
      'Run ONE read-only statement (SELECT, WITH ... SELECT, EXPLAIN, SHOW, DESCRIBE, PRAGMA reads) and get the ' +
      `columns plus up to ${MAX_ROWS} rows as JSON (rows are arrays in column order, at most ${MAX_PAYLOAD_BYTES} bytes). ` +
      'Keep results small: aggregate, filter, and add LIMIT/TOP. Writes are always refused: these connections are read-only.',
    shape: { connection, database, sql: z.string().describe('Exactly one read-only SQL statement in the engine dialect.') }
  }
];

const ok = (payload: unknown): ToolOutput => ({ text: JSON.stringify(payload), isError: false });

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export class ExternalTools {
  constructor(
    private readonly services: ExternalServices,
    private readonly source: 'mcp' | 'cli' = 'mcp',
    /** Off when the caller writes its own audit entry (the CLI). */
    private readonly audit = true
  ) {}

  /** Dispatch by tool name. Never throws; failures come back as error output. */
  async call(name: string, input: unknown, signal: AbortSignal = new AbortController().signal): Promise<ToolOutput> {
    const args = (input ?? {}) as Record<string, unknown>;
    const started = Date.now();
    let target: Target | undefined;
    let out: ToolOutput;
    try {
      if (name === 'list_connections') {
        out = this.listConnections();
      } else {
        target = this.services.target(str(args.connection) ?? '', str(args.database));
        out = await this.callOn(target, name, args, signal);
      }
    } catch (err) {
      out = failureFromError(err);
    }
    if (this.audit && name !== 'list_connections') {
      appendAudit({
        source: this.source,
        action: name,
        connection: target?.profile.name ?? str(args.connection),
        database: target ? target.ref.database ?? (target.profile.database || undefined) : str(args.database),
        ...(name === 'run_select' ? { sql: str(args.sql) ?? '' } : {}),
        ...(name === 'describe_table' || name === 'table_ddl' ? { object: `${str(args.schema) ? `${args.schema}.` : ''}${str(args.table) ?? ''}` } : {}),
        durationMs: Date.now() - started,
        ...(name === 'run_select' && !out.isError ? { rowCount: rowCountOf(out.text) } : {}),
        ...(out.isError ? { error: errorText(out.text) } : {})
      });
    }
    return out;
  }

  listConnections(): ToolOutput {
    const connections = this.services.profiles().map((p) => ({
      name: p.name,
      id: p.id,
      engine: p.kind,
      ...(p.kind === 'sqlite' ? {} : { database: p.database || '(server default)', other_databases: allowedDatabases(p).filter((d) => d !== p.database) }),
      ...(p.production ? { production: true } : {}),
      read_only: true
    }));
    return ok({
      connections,
      ...(connections.length === 0
        ? { note: 'No connections are shared. The user can turn on "Claude Code access" for a connection in Database Tool.' }
        : {})
    });
  }

  private async callOn(target: Target, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput> {
    const host = new ToolHost({
      registry: this.services.registry,
      conn: target.ref,
      profile: target.profile,
      editor: null,
      allowWrites: false,
      grants: new WriteGrants(),
      signal
    });
    switch (name) {
      case 'list_schemas':
        return host.call('list_schemas', {});
      case 'list_tables':
        return host.call('list_tables', { schema: str(args.schema) });
      case 'describe_table':
        return host.call('describe_table', { table: str(args.table) ?? '', schema: str(args.schema) });
      case 'run_select': {
        const sql = typeof args.sql === 'string' ? args.sql : '';
        const refusal = sql.trim() ? externalReadRefusal(sql, target.profile.kind) : null;
        if (refusal) {
          return { text: JSON.stringify({ error: `${refusal} Give the SQL to the user to run in Database Tool instead.` }), isError: true };
        }
        return host.call('run_select', { sql });
      }
      case 'table_ddl': {
        const table = str(args.table)?.trim();
        if (!table) return { text: JSON.stringify({ error: '`table` is required.' }), isError: true };
        const d = await this.services.acquire(target);
        const schema = str(args.schema)?.trim() || (await d.listSchemas()).defaultSchema;
        const ddl = await d.tableDdl(schema, table);
        const cut = Buffer.byteLength(ddl, 'utf8') > MAX_PAYLOAD_BYTES;
        return ok({ schema, table, ddl: cut ? ddl.slice(0, MAX_PAYLOAD_BYTES / 2) : ddl, ...(cut ? { truncated: true } : {}) });
      }
      default:
        return { text: JSON.stringify({ error: `Unknown tool: ${name}` }), isError: true };
    }
  }
}

function rowCountOf(text: string): number | undefined {
  try {
    const n = (JSON.parse(text) as { row_count?: unknown }).row_count;
    return typeof n === 'number' ? n : undefined;
  } catch {
    return undefined;
  }
}

function errorText(text: string): string {
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error;
    return typeof e === 'string' ? e : text;
  } catch {
    return text;
  }
}
