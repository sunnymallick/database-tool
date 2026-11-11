/**
 * The db-tool command line: read-only access to the connections shared with
 * Claude Code in Database Tool. `run` has no side effects on the process, so
 * tests can drive it with captured streams; index.ts is the real entry point.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ForeignKeyInfo } from '@shared/types';
import { QueryFailure } from '../main/db/driver';
import { AppError } from '../main/errors';
import { allowedDatabases, externalReadRefusal, NOT_EXPOSED_CODE, parseScope, type ConnectionScope } from '../main/external/access';
import { appendAudit } from '../main/external/audit';
import { ExternalServices, type ExternalDeps, type Target } from '../main/external/services';
import { ExternalTools } from '../main/external/tools';
import { FORMATS, formatRecords, formatResults, jsonText, type Format } from './format';
import { serveMcp } from './mcp';

export const EXIT = { ok: 0, error: 1, usage: 2, denied: 3 } as const;

/** Rows a `query` prints unless --limit says otherwise. */
export const DEFAULT_LIMIT = 1000;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether stdout is a terminal (picks the default format). */
  stdoutIsTTY: boolean;
  /** Reads all of stdin; undefined when stdin is a terminal. */
  readStdin?: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export const HELP = `db-tool: read-only access to the databases you shared with Claude Code in Database Tool.

Usage:
  db-tool connections                          List shared connections
  db-tool schemas  <conn> [--db NAME]          List schemas
  db-tool tables   <conn> [SCHEMA] [--db NAME] List tables and views
  db-tool describe <conn> <TABLE> [--schema S] [--db NAME]
  db-tool ddl      <conn> <TABLE> [--schema S] [--db NAME]
  db-tool query    <conn> "<SQL>" [--db NAME] [--format F] [--limit N]
  db-tool query    <conn> -f FILE.sql | -     (SQL from a file or stdin)
  db-tool mcp                                  Run the MCP server for Claude Code

Options:
  --format table|json|csv|tsv   Output format (default: table on a terminal, json when piped)
  --limit N                     Rows per result set for query (default ${DEFAULT_LIMIT}, 0 = no limit)
  --connections "A,B"           Only use these shared connections (also DB_TOOL_CONNECTIONS)
  -h, --help                    Show this help
  -v, --version                 Show the version

<conn> is a connection name (case-insensitive) or id. Only connections with
"Claude Code access" turned on in Database Tool are visible, and every
statement is checked as read-only before it runs.

Register the MCP server in a project:
  claude mcp add db-tool -- db-tool mcp
`;

class UsageError extends Error {}

function fail(io: CliIo, err: unknown): number {
  if (err instanceof UsageError) {
    io.stderr(`db-tool: ${err.message}\nRun "db-tool --help" for usage.\n`);
    return EXIT.usage;
  }
  if (err instanceof QueryFailure) {
    const e = err.error;
    io.stderr(`error: ${e.message}${e.detail ? `\ndetail: ${e.detail}` : ''}${e.hint ? `\nhint: ${e.hint}` : ''}\n`);
    return EXIT.error;
  }
  const message = err instanceof Error ? err.message : String(err);
  io.stderr(`error: ${message}\n`);
  const code = err instanceof AppError ? err.code : undefined;
  return code === NOT_EXPOSED_CODE || code === 'READ_ONLY' || code === 'AMBIGUOUS' ? EXIT.denied : EXIT.error;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: 'string' },
        schema: { type: 'string' },
        format: { type: 'string' },
        limit: { type: 'string' },
        file: { type: 'string', short: 'f' },
        connections: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' }
      }
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message.replace(/^.*?: /, '') : String(err));
  }
}

function pickFormat(raw: string | undefined, io: CliIo): Format {
  if (raw === undefined) return io.stdoutIsTTY ? 'table' : 'json';
  if (!(FORMATS as readonly string[]).includes(raw)) throw new UsageError(`--format must be one of ${FORMATS.join(', ')}`);
  return raw as Format;
}

function pickLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw new UsageError('--limit must be a whole number (0 = no limit)');
  return Number.parseInt(raw, 10);
}

const fkLine = (f: ForeignKeyInfo) => `${f.name}: (${f.columns.join(', ')}) -> ${f.refSchema}.${f.refTable}(${f.refColumns.join(', ')})`;

/** Commands that touch a database; each writes one audit entry, success or not. */
const AUDITED = new Set(['schemas', 'tables', 'describe', 'ddl', 'query']);

/** --connections, else DB_TOOL_CONNECTIONS. A value that is set but names nothing is an error, not "everything". */
function scopeFrom(flag: string | undefined, env: NodeJS.ProcessEnv): ConnectionScope {
  const raw = flag ?? env.DB_TOOL_CONNECTIONS;
  const scope = parseScope(raw);
  if (raw !== undefined && scope.length === 0) {
    throw new UsageError('--connections (or DB_TOOL_CONNECTIONS) is set but names no connection');
  }
  return scope;
}

/** What one CLI call did, for the audit log. */
interface CallRecord {
  target?: Target;
  connection?: string;
  sql?: string;
  object?: string;
  rowCount?: number;
}

export async function run(argv: string[], io: CliIo, deps: ExternalDeps = {}, version = '0.0.0'): Promise<number> {
  let services: ExternalServices | undefined;
  let command: string | undefined;
  const record: CallRecord = {};
  const started = Date.now();
  let error: string | undefined;
  try {
    const { values, positionals } = parse(argv);
    if (values.version) {
      io.stdout(`${version}\n`);
      return EXIT.ok;
    }
    const rest = positionals.slice(1);
    command = positionals[0];
    if (values.help || !command || command === 'help') {
      io.stdout(HELP);
      return command || values.help ? EXIT.ok : EXIT.usage;
    }

    const svc = new ExternalServices({ scope: scopeFrom(values.connections, io.env), ...deps });
    services = svc;

    if (command === 'mcp') {
      await serveMcp(svc, version, undefined, io.signal);
      return EXIT.ok;
    }

    const format = pickFormat(values.format, io);
    const pretty = io.stdoutIsTTY;
    const needConn = (): Target => {
      const conn = rest[0];
      if (!conn) throw new UsageError(`${command} needs a connection name`);
      record.connection = conn;
      record.target = svc.target(conn, values.db);
      return record.target;
    };
    const needArg = (index: number, what: string): string => {
      const v = rest[index];
      if (!v) throw new UsageError(`${command} needs ${what}`);
      return v;
    };

    switch (command) {
      case 'connections': {
        const profiles = svc.profiles();
        const json = JSON.parse(new ExternalTools(svc, 'cli', false).listConnections().text);
        const rows = profiles.map((p) => [p.name, p.kind, p.kind === 'sqlite' ? p.filePath : allowedDatabases(p).join(', ') || '(server default)', p.production ? 'yes' : '']);
        io.stdout(`${formatRecords(['NAME', 'ENGINE', 'DATABASES', 'PROD'], rows, format, json, pretty)}\n`);
        if (profiles.length === 0 && format === 'table') {
          io.stderr('No connections are shared. Turn on "Claude Code access" for a connection in Database Tool (connection settings, Safety).\n');
        }
        return EXIT.ok;
      }

      case 'schemas': {
        const d = await svc.acquire(needConn());
        const list = await d.listSchemas();
        const rows = list.schemas.map((s) => [s, s === list.defaultSchema ? 'yes' : '']);
        io.stdout(`${formatRecords(['SCHEMA', 'DEFAULT'], rows, format, { default_schema: list.defaultSchema, schemas: list.schemas }, pretty)}\n`);
        return EXIT.ok;
      }

      case 'tables': {
        const d = await svc.acquire(needConn());
        const schema = rest[1] || (await d.listSchemas()).defaultSchema;
        record.object = schema;
        const tables = await d.listTables(schema);
        const rows = tables.map((t) => [t.name, t.kind, t.rowEstimate != null ? String(t.rowEstimate) : '']);
        const json = { schema, tables: tables.map((t) => ({ name: t.name, kind: t.kind, ...(t.rowEstimate != null ? { rows: t.rowEstimate } : {}) })) };
        io.stdout(`${formatRecords(['NAME', 'KIND', 'ROWS'], rows, format, json, pretty)}\n`);
        return EXIT.ok;
      }

      case 'describe': {
        const target = needConn();
        const table = needArg(1, 'a table name');
        record.object = `${values.schema ? `${values.schema}.` : ''}${table}`;
        if (format === 'json') {
          const out = await new ExternalTools(svc, 'cli', false).call(
            'describe_table',
            { connection: target.profile.id, database: target.ref.database, table, schema: values.schema },
            io.signal
          );
          if (out.isError) throw new AppError(JSON.parse(out.text).error);
          io.stdout(`${jsonText(JSON.parse(out.text), pretty)}\n`);
          return EXIT.ok;
        }
        const d = await svc.acquire(target);
        const schema = values.schema || (await d.listSchemas()).defaultSchema;
        record.object = `${schema}.${table}`;
        const s = await d.describeTable(schema, table);
        const cols = s.columns.map((c) => [
          c.name,
          c.type,
          c.nullable ? '' : 'NOT NULL',
          c.isPrimaryKey ? 'PK' : '',
          c.defaultValue ?? '',
          c.comment ?? ''
        ]);
        const parts = [`${s.kind} ${s.schema}.${s.name}${s.rowEstimate != null ? ` (~${s.rowEstimate} rows)` : ''}`, formatRecords(['COLUMN', 'TYPE', 'NULL', 'KEY', 'DEFAULT', 'COMMENT'], cols, format, null)];
        if (format === 'table') {
          if (s.indexes.length) parts.push(`Indexes:\n${s.indexes.map((i) => `  ${i.name}${i.unique ? ' UNIQUE' : ''} (${i.columns.join(', ')})`).join('\n')}`);
          if (s.foreignKeys.length) parts.push(`Foreign keys:\n${s.foreignKeys.map((f) => `  ${fkLine(f)}`).join('\n')}`);
          if (s.referencedBy.length) parts.push(`Referenced by:\n${s.referencedBy.map((f) => `  ${f.schema}.${f.table} ${fkLine(f)}`).join('\n')}`);
          if (s.checks.length) parts.push(`Checks:\n${s.checks.map((c) => `  ${c.name}: ${c.definition}`).join('\n')}`);
        }
        io.stdout(`${parts.join('\n\n')}\n`);
        return EXIT.ok;
      }

      case 'ddl': {
        const target = needConn();
        const table = needArg(1, 'a table name');
        record.object = `${values.schema ? `${values.schema}.` : ''}${table}`;
        const d = await svc.acquire(target);
        const schema = values.schema || (await d.listSchemas()).defaultSchema;
        record.object = `${schema}.${table}`;
        const ddl = await d.tableDdl(schema, table);
        io.stdout(format === 'json' ? `${jsonText({ schema, table, ddl }, pretty)}\n` : `${ddl.trimEnd()}\n`);
        return EXIT.ok;
      }

      case 'query': {
        const target = needConn();
        const limit = pickLimit(values.limit);
        let sql: string;
        if (values.file !== undefined) {
          sql = values.file === '-' ? await stdinOrFail(io) : readFileSync(values.file, 'utf8');
        } else if (rest[1] === '-' || (rest[1] === undefined && io.readStdin)) {
          sql = await stdinOrFail(io);
        } else {
          sql = needArg(1, 'SQL (as an argument, with -f FILE, or on stdin)');
        }
        if (!sql.trim()) throw new UsageError('the SQL is empty');
        record.sql = sql;
        const refusal = externalReadRefusal(sql, target.profile.kind);
        if (refusal) throw new AppError(`${refusal} Run changes in Database Tool.`, 'READ_ONLY');
        const d = await svc.acquire(target);
        try {
          const results = await d.execute(sql, { rowCap: limit, signal: io.signal });
          record.rowCount = results.reduce((n, r) => n + r.rows.length, 0);
          const text = formatResults(results, format, pretty);
          if (text) io.stdout(`${text}\n`);
          if (format !== 'table' && results.some((r) => r.truncated)) {
            io.stderr(`note: some results were cut at --limit ${limit}\n`);
          }
          return EXIT.ok;
        } catch (err) {
          if (err instanceof QueryFailure && err.partial.length) io.stdout(`${formatResults(err.partial, format, pretty)}\n`);
          throw err;
        }
      }

      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    error = err instanceof QueryFailure ? err.error.message : err instanceof Error ? err.message : String(err);
    return fail(io, err);
  } finally {
    if (command && AUDITED.has(command) && (record.target || record.connection)) {
      const t = record.target;
      appendAudit({
        source: 'cli',
        action: command,
        connection: t?.profile.name ?? record.connection,
        ...(t ? { database: t.ref.database ?? (t.profile.database || undefined) } : {}),
        ...(record.sql !== undefined ? { sql: record.sql } : {}),
        ...(record.object ? { object: record.object } : {}),
        durationMs: Date.now() - started,
        ...(record.rowCount !== undefined ? { rowCount: record.rowCount } : {}),
        ...(error ? { error } : {})
      });
    }
    await services?.close();
  }
}

async function stdinOrFail(io: CliIo): Promise<string> {
  if (!io.readStdin) throw new UsageError('no SQL on stdin (stdin is a terminal)');
  return io.readStdin();
}
