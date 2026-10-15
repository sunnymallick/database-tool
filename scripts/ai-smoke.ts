/**
 * Live smoke test for the AI slice: real Agent SDK + the user's Claude login,
 * against a temp COPY of tests/fixtures/sample.sqlite through a minimal
 * node:sqlite registry (independent of the data layer's drivers).
 *
 *   DATABASE_TOOL_HOME=$(mktemp -d) npx tsx scripts/ai-smoke.ts
 *
 * Scenarios (model claude-haiku-5-5 to keep usage small):
 *  a) "How many orders are there per status?" must call run_select and answer with the counts.
 *  b) An insert request must produce an approval-required run_statement, which is rejected;
 *     the turn must still finish cleanly and the row must not exist.
 *  c) A follow-up in conversation (a) must be answered from the resumed session.
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AiEvent } from '../src/shared/ai';
import { splitStatements } from '../src/shared/sql';
import {
  DEFAULT_SETTINGS,
  type ConnRef,
  type ConnectionProfile,
  type ConnectionStatus,
  type DbMeta,
  type ResultSet,
  type SchemaList,
  type TableInfo,
  type TableStructure,
  type Value
} from '../src/shared/types';
import { QueryFailure, type Driver, type ExecuteOptions } from '../src/main/db/driver';
import type { ConnectionRegistry, DataServices } from '../src/main/services';

if (!process.env.DATABASE_TOOL_HOME) process.env.DATABASE_TOOL_HOME = mkdtempSync(join(tmpdir(), 'dbtool-ai-smoke-'));
const HOME = process.env.DATABASE_TOOL_HOME;
const MODEL = process.env.AI_SMOKE_MODEL ?? 'claude-haiku-5-5';

// ---------------------------------------------------------------------------
// Minimal SQLite driver + registry
// ---------------------------------------------------------------------------

function toValue(v: unknown): Value {
  if (v === null || v === undefined) return { t: 'null' };
  if (typeof v === 'bigint') return { t: 'int', v: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { t: 'int', v: String(v) } : { t: 'float', v };
  if (typeof v === 'string') return { t: 'text', v };
  if (v instanceof Uint8Array) return { t: 'bytes', hex: Buffer.from(v).toString('hex'), length: v.length };
  return { t: 'text', v: String(v) };
}

class SqliteDriver implements Driver {
  readonly kind = 'sqlite' as const;
  constructor(
    private readonly db: DatabaseSync,
    readonly database: string
  ) {}
  async serverVersion() {
    return String((this.db.prepare('select sqlite_version() v').get() as { v: string }).v);
  }
  async ping() {}
  async close() {
    this.db.close();
  }
  async listDatabases() {
    return ['main'];
  }
  async listSchemas(): Promise<SchemaList> {
    return { schemas: ['main'], defaultSchema: 'main' };
  }
  async listTables(_schema: string): Promise<TableInfo[]> {
    const rows = this.db
      .prepare("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name")
      .all() as { name: string; type: string }[];
    return rows.map((r) => ({ schema: 'main', name: r.name, kind: r.type === 'view' ? 'view' : 'table' }));
  }
  async listRoutines() {
    return [];
  }
  async describeTable(schema: string, table: string): Promise<TableStructure> {
    const cols = this.db.prepare(`pragma table_info("${table.replace(/"/g, '""')}")`).all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];
    if (cols.length === 0) throw new Error(`no such table: ${table}`);
    const fks = this.db.prepare(`pragma foreign_key_list("${table.replace(/"/g, '""')}")`).all() as {
      id: number;
      table: string;
      from: string;
      to: string;
    }[];
    return {
      schema,
      name: table,
      kind: 'table',
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: !c.notnull && !c.pk,
        defaultValue: c.dflt_value,
        isPrimaryKey: c.pk > 0,
        isIdentity: false,
        ordinal: c.cid + 1
      })),
      primaryKey: cols.filter((c) => c.pk > 0).map((c) => c.name),
      indexes: [],
      foreignKeys: fks.map((f) => ({
        name: `fk_${table}_${f.id}`,
        schema,
        table,
        columns: [f.from],
        refSchema: schema,
        refTable: f.table,
        refColumns: [f.to]
      })),
      referencedBy: [],
      checks: []
    };
  }
  async tableDdl(): Promise<string> {
    throw new Error('not in smoke driver');
  }
  async routineDefinition(): Promise<string> {
    throw new Error('not in smoke driver');
  }
  async execute(sql: string, opts: ExecuteOptions): Promise<ResultSet[]> {
    const out: ResultSet[] = [];
    const stmts = splitStatements(sql, 'sqlite');
    for (const [i, s] of stmts.entries()) {
      const started = Date.now();
      try {
        const st = this.db.prepare(s.text);
        const columns = st.columns();
        if (columns.length > 0) {
          const rows: Value[][] = [];
          let truncated = false;
          for (const row of st.iterate() as Iterable<Record<string, SQLInputValue>>) {
            if (opts.rowCap > 0 && rows.length >= opts.rowCap) {
              truncated = true;
              break;
            }
            rows.push(columns.map((c) => toValue(row[c.name])));
          }
          out.push({
            columns: columns.map((c) => ({ name: c.name, type: c.type ?? '' })),
            rows,
            truncated,
            statement: s.text,
            statementIndex: i,
            durationMs: Date.now() - started
          });
        } else {
          const r = st.run();
          out.push({
            columns: [],
            rows: [],
            rowsAffected: Number(r.changes),
            truncated: false,
            statement: s.text,
            statementIndex: i,
            durationMs: Date.now() - started
          });
        }
      } catch (err) {
        throw new QueryFailure({ message: err instanceof Error ? err.message : String(err), statementIndex: i }, out);
      }
    }
    return out;
  }
  async fetchRows(): Promise<never> {
    throw new Error('not in smoke driver');
  }
  async applyChanges(): Promise<never> {
    throw new Error('not in smoke driver');
  }
  async fetchMeta(): Promise<DbMeta> {
    const tables = await this.listTables('main');
    return {
      defaultSchema: 'main',
      schemas: ['main'],
      tables: await Promise.all(
        tables.map(async (t) => ({
          schema: 'main',
          name: t.name,
          kind: t.kind,
          columns: (await this.describeTable('main', t.name)).columns.map((c) => ({ name: c.name, type: c.type }))
        }))
      )
    };
  }
}

const dbCopy = join(HOME, 'sample-copy.sqlite');
copyFileSync(resolve('tests/fixtures/sample.sqlite'), dbCopy);
const now = new Date().toISOString();
const profile: ConnectionProfile = {
  id: 'smoke-sqlite',
  name: 'Sample shop (smoke)',
  kind: 'sqlite',
  host: '',
  port: 0,
  database: '',
  username: '',
  filePath: dbCopy,
  ssl: false,
  trustServerCertificate: false,
  options: {},
  extraDatabases: [],
  color: null,
  group: null,
  production: false,
  readOnly: false,
  hasPassword: false,
  createdAt: now,
  updatedAt: now
};
const driver = new SqliteDriver(new DatabaseSync(dbCopy), dbCopy);
const registry: ConnectionRegistry = {
  listProfiles: () => [profile],
  getProfile: (id) => (id === profile.id ? profile : undefined),
  status: (ref: ConnRef): ConnectionStatus => ({ profileId: ref.profileId, database: dbCopy, state: 'connected' }),
  acquire: async () => driver
};
const services: DataServices = {
  registry,
  getSettings: () => ({ ...DEFAULT_SETTINGS, aiModel: MODEL }),
  recordHistory: (e) => console.log(`  [history] ${e.connectionName}: ${e.sql}${e.error ? ` (error: ${e.error})` : ''}`),
  shutdown: async () => {}
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// `npx tsx` only reads the root tsconfig.json, which has no `paths`; map the
// `@shared/*` alias used by src/main for the modules imported below.
const sharedUrl = pathToFileURL(resolve('src/shared') + '/').href;
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@shared/')) return next(new URL(specifier.slice(8) + '.ts', ${JSON.stringify(sharedUrl)}).href, context);
  return next(specifier, context);
}`)
);

// Imported after DATABASE_TOOL_HOME is set (the provider creates its workspace under it).
const { AgentSdkProvider } = await import('../src/main/ai/agent-sdk');
const { AiSessionManager } = await import('../src/main/ai/sessions');

const events: AiEvent[] = [];
let onEvent: (e: AiEvent) => void = () => {};
let initLogged = false;
const provider = new AgentSdkProvider(services, {
  onMessage: (msg) => {
    if (msg.type === 'system' && msg.subtype === 'init' && !initLogged) {
      initLogged = true;
      console.log(`  [init] model=${msg.model} permissionMode=${msg.permissionMode} cwd=${msg.cwd}`);
      console.log(`  [init] tools=${msg.tools.join(', ')}`);
      console.log(`  [init] mcp_servers=${msg.mcp_servers.map((s) => `${s.name}:${s.status}`).join(', ')}`);
      console.log(`  [init] skills=${msg.skills.length} plugins=${msg.plugins.length} slash_commands=${msg.slash_commands.length}`);
    }
  }
});
const manager = new AiSessionManager(provider, (e) => {
  events.push(e);
  onEvent(e);
});

function log(e: AiEvent): void {
  switch (e.type) {
    case 'text_delta':
      process.stdout.write(e.text);
      break;
    case 'tool_call':
      console.log(`\n  [tool_call] ${e.name} kind=${e.kind} needsApproval=${e.needsApproval}\n    ${e.preview.replace(/\n/g, '\n    ')}`);
      break;
    case 'tool_result':
      console.log(`  [tool_result] ok=${e.ok}${e.denied ? ' denied' : ''}: ${e.summary}`);
      break;
    case 'propose_sql':
      console.log(`\n  [propose_sql] ${e.sql.replace(/\n/g, ' ')}`);
      break;
    case 'status':
      console.log(`  [status] ${e.message}`);
      break;
    case 'error':
      console.log(`\n  [error:${e.code}] ${e.message}`);
      break;
    case 'turn_done':
      console.log(
        `\n  [turn_done] ${e.cancelled ? 'cancelled ' : ''}${e.failed ? 'failed ' : ''}duration=${e.durationMs}ms cost=$${e.costUsd?.toFixed(4)}`
      );
      break;
  }
}

async function turn(sessionId: string, prompt: string, react?: (e: AiEvent) => void): Promise<AiEvent[]> {
  const start = events.length;
  onEvent = (e) => {
    log(e);
    react?.(e);
  };
  console.log(`\n> ${prompt}`);
  manager.send({ sessionId, prompt, conn: { profileId: profile.id }, model: MODEL, allowWrites: false, editor: null });
  await manager.idle(sessionId);
  // idle() resolves after the turn's finally block; give the last emit a tick.
  await new Promise((r) => setImmediate(r));
  return events.slice(start);
}

const failures: string[] = [];
const check = (cond: boolean, what: string) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${what}`);
  if (!cond) failures.push(what);
};

console.log(`AI smoke: model=${MODEL} home=${HOME}`);
const status = await manager.status(true);
console.log(
  `  [status] available=${status.available} cli=${status.cliSource}:${status.cliPath} version=${status.version} loggedIn=${status.loggedIn}${status.error ? ` error=${status.error}` : ''}`
);
check(status.available, 'ai.status finds the CLI');

// (a) read question
const a = await turn('smoke-a', 'How many orders are there per status?');
const aText = a.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
const counts = (await driver.execute('select status, count(*) n from orders group by status', { rowCap: 0 }))[0];
const expected = counts.rows.map((r) => (r[1].t === 'int' ? r[1].v : '')).filter(Boolean);
check(a.some((e) => e.type === 'tool_call' && e.name === 'run_select'), '(a) called run_select');
check(a.some((e) => e.type === 'tool_result' && e.ok), '(a) a tool returned ok');
check(
  expected.every((n) => aText.includes(n)),
  `(a) answer mentions every count (${expected.join(', ')})`
);
check(a.at(-1)?.type === 'turn_done' && !(a.at(-1) as { failed?: boolean }).failed, '(a) turn finished cleanly');

// (c) follow-up in the same conversation: needs the resumed SDK session for context
const c = await turn('smoke-a', 'Of those statuses, which one has the fewest orders? Answer in one short sentence.');
const cText = c.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
check(/\bpaid\b/i.test(cText), '(c) follow-up answered from the resumed conversation (mentions "paid")');
check(c.at(-1)?.type === 'turn_done' && !(c.at(-1) as { failed?: boolean }).failed, '(c) turn finished cleanly');

// (b) write request, rejected
let approvalSeen = false;
const b = await turn(
  'smoke-b',
  "Insert a new customer named 'Smoke Test' with email smoke.test@example.com into the customers table. Run the insert yourself.",
  (e) => {
    if (e.type === 'tool_call' && e.name === 'run_statement' && e.needsApproval) {
      approvalSeen = true;
      console.log('  [smoke] rejecting the statement');
      manager.approve({ sessionId: 'smoke-b', toolUseId: e.toolUseId, approved: false });
    }
  }
);
check(approvalSeen, '(b) run_statement asked for approval');
check(b.some((e) => e.type === 'tool_result' && !e.ok && e.denied), '(b) the rejected call reported denied');
check(b.at(-1)?.type === 'turn_done' && !(b.at(-1) as { failed?: boolean }).failed, '(b) turn finished cleanly');
const after = (await driver.execute("select count(*) n from customers where email = 'smoke.test@example.com'", { rowCap: 0 }))[0]
  .rows[0][0];
check(after.t === 'int' && after.v === '0', '(b) no row was inserted');

manager.shutdown();
await driver.close();
console.log(failures.length ? `\nSMOKE FAILED (${failures.length}): ${failures.join('; ')}` : '\nSMOKE PASSED');
process.exit(failures.length ? 1 : 0);
