/**
 * The db-tool MCP server and CLI end to end: a real MCP client over an
 * in-memory transport, real SQLite (and local Postgres when available), and
 * a temp data directory. Nothing touches the Keychain.
 */
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionProfile } from '@shared/types';
import type { SecretStore } from '../../src/main/connections/secrets';
import { serveMcp } from '../../src/cli/mcp';
import { EXIT, run, type CliIo } from '../../src/cli/run';
import { ExternalServices } from '../../src/main/external/services';
import { AUDIT_FILE } from '../../src/main/external/audit';
import { pgAvailable, pgProfile, profile, sqliteCopy, tempDir } from './support';

const noSecrets: SecretStore = {
  kind: 'file',
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined,
  has: async () => false
};

let home: { dir: string; cleanup: () => void };
let dbFile: string;
const savedHome = process.env.DATABASE_TOOL_HOME;

function writeProfiles(profiles: ConnectionProfile[]): void {
  const file = join(home.dir, 'connections.json');
  writeFileSync(file, JSON.stringify({ version: 1, profiles }));
  // Make sure a rewrite within the same millisecond still looks changed.
  const t = new Date(Date.now() + Math.floor(Math.random() * 100_000));
  utimesSync(file, t, t);
}

const shared = () => profile('sqlite', { id: 'shared', name: 'Sample', filePath: dbFile, claudeCodeAccess: true });
const hidden = () => profile('sqlite', { id: 'hidden', name: 'Hidden', filePath: dbFile, claudeCodeAccess: false });

beforeAll(() => {
  home = tempDir('external');
  process.env.DATABASE_TOOL_HOME = home.dir;
  dbFile = sqliteCopy(home.dir);
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.DATABASE_TOOL_HOME;
  else process.env.DATABASE_TOOL_HOME = savedHome;
  home.cleanup();
});

function auditLines(): Record<string, unknown>[] {
  try {
    return readFileSync(join(home.dir, AUDIT_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe('MCP server', () => {
  let client: Client;
  let services: ExternalServices;
  let served: Promise<void>;

  beforeEach(async () => {
    writeProfiles([shared(), hidden()]);
    services = new ExternalServices({ secrets: noSecrets });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    served = serveMcp(services, 'test', serverSide);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
    await served;
  });

  const callJson = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: res.isError === true, body: JSON.parse(res.content[0].text) as Record<string, unknown> };
  };

  it('offers only read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['describe_table', 'list_connections', 'list_schemas', 'list_tables', 'run_select', 'table_ddl']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.find((t) => t.name === 'run_select')?.inputSchema.required).toEqual(['connection', 'sql']);
  });

  it('lists only shared connections', async () => {
    const { body } = await callJson('list_connections');
    expect((body.connections as { name: string }[]).map((c) => c.name)).toEqual(['Sample']);
  });

  it('reads schema and runs selects', async () => {
    const tables = await callJson('list_tables', { connection: 'sample' });
    expect((tables.body.tables as { name: string }[]).map((t) => t.name)).toContain('orders');

    const desc = await callJson('describe_table', { connection: 'Sample', table: 'orders' });
    expect(desc.isError).toBe(false);
    expect((desc.body.columns as { name: string }[]).map((c) => c.name)).toContain('customer_id');

    const ddl = await callJson('table_ddl', { connection: 'Sample', table: 'orders' });
    expect(String(ddl.body.ddl)).toMatch(/CREATE TABLE orders/);

    const sel = await callJson('run_select', { connection: 'Sample', sql: 'SELECT count(*) AS n FROM orders' });
    expect(sel.isError).toBe(false);
    expect(sel.body.rows).toEqual([[1500]]);
  });

  it('refuses writes, unshared connections, and bad arguments', async () => {
    const write = await callJson('run_select', { connection: 'Sample', sql: 'DELETE FROM orders' });
    expect(write.isError).toBe(true);
    expect(String(write.body.error)).toMatch(/read-only/);

    const unshared = await callJson('run_select', { connection: 'Hidden', sql: 'SELECT 1' });
    expect(unshared.isError).toBe(true);
    expect(String(unshared.body.error)).toMatch(/not shared|No connection "Hidden"/);

    const bad = await callJson('run_select', { connection: 'Sample' });
    expect(bad.isError).toBe(true);
    expect(String(bad.body.error)).toMatch(/Invalid arguments: sql/);

    const after = await callJson('run_select', { connection: 'Sample', sql: 'SELECT count(*) AS n FROM orders' });
    expect(after.body.rows).toEqual([[1500]]);
  });

  it('stops serving a connection as soon as access is turned off', async () => {
    expect((await callJson('run_select', { connection: 'Sample', sql: 'SELECT 1 AS x' })).isError).toBe(false);
    writeProfiles([{ ...shared(), claudeCodeAccess: false }]);
    const res = await callJson('run_select', { connection: 'Sample', sql: 'SELECT 1 AS x' });
    expect(res.isError).toBe(true);
    expect((await callJson('list_connections')).body.connections).toEqual([]);
  });

  it('writes an audit line per database call', async () => {
    const before = auditLines().length;
    await callJson('run_select', { connection: 'Sample', sql: 'SELECT 42 AS answer' });
    const lines = auditLines();
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1)).toMatchObject({ source: 'mcp', action: 'run_select', connection: 'Sample', sql: 'SELECT 42 AS answer', rowCount: 1 });
  });
});

describe('read-only enforcement below the tools', () => {
  it('hands out guarded drivers even if a write slips past the statement check', async () => {
    writeProfiles([shared()]);
    const services = new ExternalServices({ secrets: noSecrets });
    try {
      const target = services.target('Sample');
      expect(target.profile.readOnly).toBe(true);
      const d = await services.acquire(target);
      await expect(d.execute('DELETE FROM orders', { rowCap: 10 })).rejects.toMatchObject({ code: 'READ_ONLY' });
    } finally {
      await services.close();
    }
  });
});

describe('CLI', () => {
  function io(): CliIo & { out: string; err: string } {
    const s = { out: '', err: '' };
    return Object.assign(s, {
      stdout: (t: string) => void (s.out += t),
      stderr: (t: string) => void (s.err += t),
      stdoutIsTTY: false,
      env: {}
    });
  }
  const deps = { secrets: noSecrets };

  beforeEach(() => writeProfiles([shared(), hidden()]));

  it('queries as compact JSON when piped', async () => {
    const o = io();
    expect(await run(['query', 'sample', 'SELECT id, full_name FROM customers ORDER BY id LIMIT 2'], o, deps)).toBe(EXIT.ok);
    const out = JSON.parse(o.out) as { rows: Record<string, unknown>[] }[];
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0].rows[0])).toEqual(['id', 'full_name']);
    expect(o.out.trim().split('\n')).toHaveLength(1);
  });

  it('respects --limit and prints CSV', async () => {
    const o = io();
    expect(await run(['query', 'Sample', 'SELECT id FROM orders ORDER BY id', '--limit', '3', '--format', 'csv'], o, deps)).toBe(EXIT.ok);
    expect(o.out.trim().split('\n')).toEqual(['id', '1', '2', '3']);
    expect(o.err).toMatch(/cut at --limit 3/);
  });

  it('reads SQL from stdin', async () => {
    const o = { ...io(), readStdin: async () => 'SELECT 7 AS seven' };
    const captured = { out: '' };
    o.stdout = (t: string) => void (captured.out += t);
    expect(await run(['query', 'Sample'], o, deps)).toBe(EXIT.ok);
    expect(JSON.parse(captured.out)[0].rows).toEqual([{ seven: 7 }]);
  });

  it('exits 3 for writes and unshared connections, 2 for usage errors', async () => {
    const w = io();
    expect(await run(['query', 'Sample', 'UPDATE orders SET total = 0'], w, deps)).toBe(EXIT.denied);
    expect(w.err).toMatch(/read-only/);

    const h = io();
    expect(await run(['tables', 'Hidden'], h, deps)).toBe(EXIT.denied);

    const u = io();
    expect(await run(['frobnicate'], u, deps)).toBe(EXIT.usage);
    expect(await run(['query', 'Sample', 'SELECT 1', '--format', 'xml'], io(), deps)).toBe(EXIT.usage);
  });

  it('treats an empty --connections as an error, not as "all"', async () => {
    const e = io();
    expect(await run(['connections', '--connections', ''], e, deps)).toBe(EXIT.usage);
    const env = { ...io(), env: { DB_TOOL_CONNECTIONS: ' , ' } };
    expect(await run(['connections'], env, deps)).toBe(EXIT.usage);
  });

  it('audits every database command, including refusals', async () => {
    const before = auditLines().length;
    await run(['tables', 'Sample'], io(), deps);
    await run(['query', 'Sample', 'BEGIN'], io(), deps);
    await run(['schemas', 'Hidden'], io(), deps);
    const lines = auditLines().slice(before);
    expect(lines.map((l) => [l.action, l.connection, !!l.error])).toEqual([
      ['tables', 'Sample', false],
      ['query', 'Sample', true],
      ['schemas', 'Hidden', true]
    ]);
  });

  it('narrows with --connections and DB_TOOL_CONNECTIONS', async () => {
    writeProfiles([shared(), { ...shared(), id: 'other', name: 'Other' }]);
    const a = io();
    await run(['connections', '--connections', 'Other'], a, deps);
    expect(JSON.parse(a.out).connections.map((c: { name: string }) => c.name)).toEqual(['Other']);

    const b = { ...io(), env: { DB_TOOL_CONNECTIONS: 'sample' } };
    let out = '';
    b.stdout = (t: string) => void (out += t);
    await run(['connections'], b, deps);
    expect(JSON.parse(out).connections.map((c: { name: string }) => c.name)).toEqual(['Sample']);
  });

  it('describes a table as text on a terminal', async () => {
    const o = { ...io(), stdoutIsTTY: true };
    let out = '';
    o.stdout = (t: string) => void (out += t);
    expect(await run(['describe', 'Sample', 'orders'], o, deps)).toBe(EXIT.ok);
    expect(out).toMatch(/^table main\.orders/);
    expect(out).toMatch(/Foreign keys:\n {2}fk_orders_0: \(customer_id\) -> main\.customers\(id\)/);
  });
});

describe('Postgres', async () => {
  const available = await pgAvailable();

  it.skipIf(!available)('opens server-side read-only sessions', async () => {
    writeProfiles([pgProfile({ id: 'pg', name: 'Local PG', claudeCodeAccess: true })]);
    const services = new ExternalServices({ secrets: noSecrets });
    try {
      const d = await services.acquire(services.target('local pg'));
      const [rs] = await d.execute('SHOW default_transaction_read_only', { rowCap: 1 });
      expect(rs.rows[0][0]).toMatchObject({ v: 'on' });
      const [count] = await d.execute('SELECT count(*) AS n FROM sales.orders', { rowCap: 1 });
      expect(count.rows).toHaveLength(1);
    } finally {
      await services.close();
    }
  });
});
