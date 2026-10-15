/**
 * The IPC data layer end to end, through createDataServices with a fake
 * router: profiles, secrets (file backend), connections, queries, editable
 * detection, read-only enforcement, history, cancel, and dbTool import.
 * DATABASE_TOOL_HOME and DBTOOL_CONFIG_DIR point at temp dirs.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiEventName, ApiMethod, ApiReq, ApiRes } from '@shared/api';
import type { ConnectionProfile, ConnectionStatus } from '@shared/types';
import { createDataServices } from '../../src/main/ipc/data';
import type { Router } from '../../src/main/ipc/types';
import type { DataServices } from '../../src/main/services';
import { FileSecretStore, type CommandRunner } from '../../src/main/connections/secrets';
import { ROOT, pgAvailable, pgProfile, profile, sqliteCopy, tempDir } from './support';

const pgUp = await pgAvailable();

function fakeRouter() {
  const handlers = new Map<string, (req: unknown) => unknown>();
  const events: { event: ApiEventName; payload: unknown }[] = [];
  const router: Router = {
    handle(method, fn) {
      if (handlers.has(method)) throw new Error(`duplicate ${method}`);
      handlers.set(method, fn as (req: unknown) => unknown);
    },
    emit(event, payload) {
      events.push({ event, payload });
    }
  };
  async function call<K extends ApiMethod>(method: K, req: ApiReq<K>): Promise<ApiRes<K>> {
    const fn = handlers.get(method);
    if (!fn) throw new Error(`no handler for ${method}`);
    return (await fn(req)) as ApiRes<K>;
  }
  return { router, handlers, events, call };
}

const DATA_METHODS: ApiMethod[] = [
  'connections.list', 'connections.save', 'connections.delete', 'connections.test', 'connections.connect', 'connections.disconnect',
  'connections.statuses', 'connections.importDbtool', 'db.databases', 'db.schemas', 'db.tables', 'db.routines', 'db.structure', 'db.ddl',
  'db.routineDefinition', 'db.query', 'db.cancel', 'db.rows', 'db.applyChanges', 'db.meta', 'history.list', 'history.clear', 'snippets.list',
  'snippets.save', 'snippets.delete', 'settings.get', 'settings.update', 'session.load', 'session.save'
];

describe('data services (IPC handlers)', () => {
  const home = tempDir('data-home');
  const dbtool = tempDir('data-dbtool');
  const files = tempDir('data-files');
  const keychainCalls: string[][] = [];
  const keychain: CommandRunner = async (_cmd, args) => {
    keychainCalls.push(args);
    const account = args[args.indexOf('-a') + 1];
    return account.endsWith('7') ? { code: 0, stdout: 'billing-pw\n', stderr: '' } : { code: 44, stdout: '', stderr: '' };
  };
  const api = fakeRouter();
  let services: DataServices;
  let lite: ConnectionProfile;

  beforeAll(async () => {
    vi.stubEnv('DATABASE_TOOL_HOME', home.dir);
    vi.stubEnv('DBTOOL_CONFIG_DIR', dbtool.dir);
    vi.stubEnv('DATABASE_TOOL_SECRETS', 'file');
    copyFileSync(join(ROOT, 'tests/fixtures/dbtool-connections.json'), join(dbtool.dir, 'connections.json'));
    services = createDataServices(api.router, { secrets: new FileSecretStore(join(home.dir, 'secrets.json')), keychainRunner: keychain });
    lite = await api.call('connections.save', { profile: profile('sqlite', { id: '', name: 'Shop (SQLite)', filePath: sqliteCopy(files.dir) }) });
  });

  afterAll(async () => {
    await services?.shutdown();
    vi.unstubAllEnvs();
    home.cleanup();
    dbtool.cleanup();
    files.cleanup();
  });

  it('registers every data-layer method', () => {
    for (const m of DATA_METHODS) expect(api.handlers.has(m), m).toBe(true);
  });

  it('saves profiles and announces changes', async () => {
    expect(lite.id).toBeTruthy();
    expect(lite.hasPassword).toBe(false);
    const changed = api.events.filter((e) => e.event === 'connections.changed');
    expect((changed.at(-1)?.payload as ConnectionProfile[]).map((p) => p.name)).toContain('Shop (SQLite)');
    expect(existsSync(join(home.dir, 'connections.json'))).toBe(true);

    const withPw = await api.call('connections.save', { profile: profile('postgres', { id: '', name: 'Has password', host: 'db.invalid' }), password: 's3cret' });
    expect(withPw.hasPassword).toBe(true);
    expect(JSON.parse(readFileSync(join(home.dir, 'secrets.json'), 'utf8')).secrets[withPw.id]).toBe('s3cret');
    const kept = await api.call('connections.save', { profile: { ...withPw, name: 'Renamed' } });
    expect(kept.hasPassword).toBe(true);
    const cleared = await api.call('connections.save', { profile: kept, password: null });
    expect(cleared.hasPassword).toBe(false);
    await api.call('connections.delete', { profileId: kept.id });
    expect((await api.call('connections.list', undefined)).map((p) => p.name)).not.toContain('Renamed');
    await expect(api.call('connections.save', { profile: profile('postgres', { name: '' }) })).rejects.toThrow('Give the connection a name');
  });

  it('tests connections without saving them', async () => {
    const ok = await api.call('connections.test', { profile: lite });
    expect(ok).toMatchObject({ ok: true, serverVersion: expect.stringMatching(/^SQLite/) });
    const notYet = await api.call('connections.test', { profile: { ...lite, filePath: join(files.dir, 'new.sqlite') } });
    expect(notYet).toMatchObject({ ok: true, message: expect.stringContaining('will be created') });
    expect(existsSync(join(files.dir, 'new.sqlite'))).toBe(false);
    const bad = await api.call('connections.test', { profile: profile('postgres', { host: '127.0.0.1', port: 1, options: { connectTimeoutSec: '2' } }) });
    expect(bad.ok).toBe(false);
  });

  it('connects, browses, and reports status events', async () => {
    const status = await api.call('connections.connect', { profileId: lite.id });
    expect(status).toMatchObject({ profileId: lite.id, state: 'connected', serverVersion: expect.stringMatching(/^SQLite/) });
    const statusEvents = api.events.filter((e) => e.event === 'connections.status').map((e) => (e.payload as ConnectionStatus).state);
    expect(statusEvents).toEqual(expect.arrayContaining(['connecting', 'connected']));
    expect(await api.call('connections.statuses', undefined)).toEqual([expect.objectContaining({ profileId: lite.id, state: 'connected' })]);

    const conn = { profileId: lite.id };
    expect(await api.call('db.schemas', { conn })).toEqual({ schemas: ['main'], defaultSchema: 'main' });
    expect((await api.call('db.tables', { conn, schema: 'main' })).length).toBe(6);
    expect((await api.call('db.structure', { conn, schema: 'main', table: 'orders' })).primaryKey).toEqual(['id']);
    expect(await api.call('db.ddl', { conn, schema: 'main', table: 'customers' })).toContain('CREATE TABLE customers');
    expect((await api.call('db.meta', { conn })).tables.length).toBe(6);
    const page = await api.call('db.rows', { table: { conn, schema: 'main', table: 'customers' }, limit: 5, offset: 0, countTotal: true, orderBy: [{ column: 'id', desc: true }] });
    expect(page.total).toBe(200);
    expect(page.result.rows[0][0]).toEqual({ t: 'int', v: '200' });
    expect(page.result.editable).toEqual({ schema: 'main', table: 'customers', primaryKey: ['id'] });
    const viewPage = await api.call('db.rows', { table: { conn, schema: 'main', table: 'customer_order_totals' }, limit: 5, offset: 0 });
    expect(viewPage.result.editable).toBeUndefined();
    const preview = await api.call('db.applyChanges', {
      table: { conn, schema: 'main', table: 'customers' },
      changes: { updates: [{ pk: { id: { t: 'int', v: '1' } }, set: { country: { t: 'text', v: 'CA' } } }], inserts: [], deletes: [] },
      preview: true
    });
    expect(preview.statements).toEqual([`UPDATE "main"."customers" SET "country" = 'CA' WHERE "id" = 1`]);
  });

  it('runs queries with params, maps errors to the original text, and records history', async () => {
    const conn = { profileId: lite.id };
    const ok = await api.call('db.query', { conn, queryId: 'q-params', sql: 'SELECT id, email FROM customers WHERE country = :country ORDER BY id', params: { country: 'US' } });
    expect(ok.error).toBeUndefined();
    expect(ok.results[0].rows.length).toBeGreaterThan(0);
    expect(ok.results[0].statement).toContain("country = 'US'");

    const original = 'SELECT :long_parameter_name, nope FROM customers';
    const bad = await api.call('db.query', { conn, queryId: 'q-bad', sql: original, params: { long_parameter_name: '1' } });
    expect(bad.results).toEqual([]);
    expect(bad.error).toMatchObject({ message: 'no such column: nope', statementIndex: 0 });

    const syntax = 'SELECT 1;\nSELEC :x';
    const bad2 = await api.call('db.query', { conn, queryId: 'q-bad2', sql: syntax, params: { x: '12345' } });
    expect(bad2.results).toHaveLength(1);
    expect(bad2.error?.position).toBe(syntax.indexOf('SELEC :x'));

    const history = await api.call('history.list', { profileId: lite.id });
    expect(history.slice(0, 3).map((h) => h.sql)).toEqual([syntax, original, 'SELECT id, email FROM customers WHERE country = :country ORDER BY id']);
    expect(history[0]).toMatchObject({ connectionName: 'Shop (SQLite)', error: expect.stringContaining('syntax error') });
    expect(history[2].rowCount).toBeGreaterThan(0);
  });

  it('marks plain single-table selects that include the key as editable', async () => {
    const conn = { profileId: lite.id };
    const run = async (sql: string) => (await api.call('db.query', { conn, queryId: `e-${sql}`, sql })).results[0]?.editable;
    expect(await run('SELECT * FROM customers LIMIT 5')).toEqual({ schema: 'main', table: 'customers', primaryKey: ['id'] });
    expect(await run('select ID, email from Customers')).toEqual({ schema: 'main', table: 'Customers', primaryKey: ['id'] });
    expect(await run('SELECT * FROM main.order_items')).toEqual({ schema: 'main', table: 'order_items', primaryKey: ['order_id', 'product_id'] });
    expect(await run('SELECT order_id FROM order_items')).toBeUndefined();
    expect(await run('SELECT email FROM customers')).toBeUndefined();
    expect(await run('SELECT count(*) FROM customers')).toBeUndefined();
    expect(await run('SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id')).toBeUndefined();
    expect(await run('SELECT * FROM customer_order_totals')).toBeUndefined();
  });

  it('checks each result of a multi-statement script for editability', async () => {
    const conn = { profileId: lite.id };
    const sql = 'SELECT status, COUNT(*) FROM orders GROUP BY status;\nSELECT * FROM customers WHERE id <= 3;\nSELECT * FROM order_items LIMIT 2';
    const res = await api.call('db.query', { conn, queryId: 'multi-editable', sql });
    expect(res.results.map((r) => r.editable?.table)).toEqual([undefined, 'customers', 'order_items']);
  });

  it('caps rows from settings unless the request overrides it', async () => {
    const conn = { profileId: lite.id };
    await api.call('settings.update', { rowCap: 10 });
    expect(api.events.filter((e) => e.event === 'settings.changed').at(-1)?.payload).toMatchObject({ rowCap: 10 });
    const capped = await api.call('db.query', { conn, queryId: 'cap-1', sql: 'SELECT * FROM orders' });
    expect(capped.results[0]).toMatchObject({ truncated: true });
    expect(capped.results[0].rows).toHaveLength(10);
    const all = await api.call('db.query', { conn, queryId: 'cap-2', sql: 'SELECT * FROM orders', rowCap: 0 });
    expect(all.results[0].rows).toHaveLength(1500);
    expect(services.getSettings().rowCap).toBe(10);
    await api.call('settings.update', { rowCap: 5000 });
  });

  it('enforces read-only profiles for queries and edits', async () => {
    const ro = await api.call('connections.save', { profile: profile('sqlite', { id: '', name: 'Read only', filePath: sqliteCopy(files.dir), readOnly: true }) });
    const conn = { profileId: ro.id };
    const sql = 'SELECT 1;\n  DELETE FROM orders';
    const refused = await api.call('db.query', { conn, queryId: 'ro-1', sql });
    expect(refused.error).toMatchObject({ code: 'READ_ONLY', statementIndex: 1, position: sql.indexOf('DELETE') });
    expect(refused.results).toEqual([]);
    const fine = await api.call('db.query', { conn, queryId: 'ro-2', sql: 'SELECT count(*) FROM orders' });
    expect(fine.results[0].rows[0][0]).toEqual({ t: 'int', v: '1500' });
    await expect(
      api.call('db.applyChanges', { table: { conn, schema: 'main', table: 'orders' }, changes: { updates: [], inserts: [], deletes: [{ id: { t: 'int', v: '1' } }] }, preview: false })
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    // The AI slice gets the same guarded driver.
    const driver = await services.registry.acquire(conn);
    await expect(driver.execute('DROP TABLE orders', { rowCap: 10 })).rejects.toMatchObject({ code: 'READ_ONLY' });
  });

  it('stores snippets, session state, and clears history', async () => {
    const s = await api.call('snippets.save', { id: '', name: 'Top customers', sql: 'SELECT 1', updatedAt: '' });
    expect((await api.call('snippets.list', undefined)).map((x) => x.id)).toEqual([s.id]);
    await api.call('snippets.delete', { id: s.id });
    expect(await api.call('snippets.list', undefined)).toEqual([]);
    expect(await api.call('session.load', undefined)).toBeNull();
    await api.call('session.save', { tabs: ['a'] });
    expect(await api.call('session.load', undefined)).toEqual({ tabs: ['a'] });
    services.recordHistory({ profileId: 'ai', connectionName: 'AI', sql: 'SELECT 42' });
    expect((await api.call('history.list', { profileId: 'ai' }))[0].sql).toBe('SELECT 42');
    await api.call('history.clear', undefined);
    expect(await api.call('history.list', {})).toEqual([]);
  });

  it('imports dbTool profiles with Keychain passwords', async () => {
    const before = api.events.filter((e) => e.event === 'connections.changed').length;
    const result = await api.call('connections.importDbtool', { includePasswords: true });
    expect(result.sourcePath).toBe(join(dbtool.dir, 'connections.json'));
    expect(result.imported.map((p) => p.name)).toEqual(['Local Postgres', 'Orders (prod)', 'Legacy MySQL via bastion', 'Scratch SQLite', 'Billing', 'Reporting replica']);
    expect(result.passwordsImported).toBe(2);
    expect(result.imported.find((p) => p.name === 'Billing')?.hasPassword).toBe(true);
    expect(result.skipped.map((s) => s.name)).toEqual(['Local Postgres (copy)', 'Warehouse']);
    expect(result.warnings?.map((w) => w.name)).toEqual(['Legacy MySQL via bastion']);
    expect(keychainCalls).toHaveLength(4);
    expect(api.events.filter((e) => e.event === 'connections.changed').length).toBe(before + 1);
    const again = await api.call('connections.importDbtool', { includePasswords: false });
    expect(again.imported).toEqual([]);
    expect(again.skipped).toHaveLength(8);
  });

  describe.skipIf(!pgUp)('postgres through the registry', () => {
    let pgId = '';

    beforeAll(async () => {
      const saved = await api.call('connections.save', { profile: pgProfile({ id: '', name: 'Test PG' }) });
      pgId = saved.id;
    });

    it('detects editable results with Postgres case folding', async () => {
      const conn = { profileId: pgId };
      const r = await api.call('db.query', { conn, queryId: 'pg-e1', sql: 'SELECT * FROM sales.orders LIMIT 3' });
      expect(r.results[0].editable).toEqual({ schema: 'sales', table: 'orders', primaryKey: ['id'] });
      const folded = await api.call('db.query', { conn, queryId: 'pg-e2', sql: 'select ID, Status from Sales.Orders limit 1' });
      expect(folded.results[0].editable).toEqual({ schema: 'sales', table: 'orders', primaryKey: ['id'] });
      const unqualified = await api.call('db.query', { conn, queryId: 'pg-e3', sql: 'SELECT id, email FROM customers LIMIT 1' });
      expect(unqualified.results[0].editable).toEqual({ schema: 'public', table: 'customers', primaryKey: ['id'] });
      // Unqualified names resolve through the console session's search_path, like the server does.
      await api.call('db.query', { conn, queryId: 'pg-sp', sql: 'SET search_path TO sales, public' });
      const viaPath = await api.call('db.query', { conn, queryId: 'pg-e4', sql: 'SELECT * FROM orders LIMIT 1' });
      expect(viaPath.results[0].editable).toEqual({ schema: 'sales', table: 'orders', primaryKey: ['id'] });
      const fallsThrough = await api.call('db.query', { conn, queryId: 'pg-e5', sql: 'SELECT * FROM customers LIMIT 1' });
      expect(fallsThrough.results[0].editable).toEqual({ schema: 'public', table: 'customers', primaryKey: ['id'] });
      await api.call('db.query', { conn, queryId: 'pg-sp2', sql: 'RESET search_path' });
    });

    it('cancels SELECT pg_sleep(10) through db.cancel', async () => {
      const started = Date.now();
      const running = api.call('db.query', { conn: { profileId: pgId }, queryId: 'pg-sleep', sql: 'SELECT pg_sleep(10)' });
      await new Promise((r) => setTimeout(r, 300));
      await api.call('db.cancel', { queryId: 'pg-sleep' });
      const res = await running;
      expect(res.cancelled).toBe(true);
      expect(res.error).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(5000);
      const [entry] = await api.call('history.list', { profileId: pgId, limit: 1 });
      expect(entry).toMatchObject({ sql: 'SELECT pg_sleep(10)', error: 'Cancelled' });
      // The session is still usable.
      const after = await api.call('db.query', { conn: { profileId: pgId }, queryId: 'pg-after', sql: 'SELECT 1' });
      expect(after.error).toBeUndefined();
    });

    it('refuses writes on read-only Postgres profiles before they reach the server', async () => {
      const ro = await api.call('connections.save', { profile: pgProfile({ id: '', name: 'Test PG (read-only)', readOnly: true }) });
      const res = await api.call('db.query', { conn: { profileId: ro.id }, queryId: 'pg-ro', sql: 'WITH x AS (SELECT 1) DELETE FROM sales.orders WHERE id < 0' });
      expect(res.error).toMatchObject({ code: 'READ_ONLY', message: expect.stringContaining('DELETE') });
      const read = await api.call('db.query', { conn: { profileId: ro.id }, queryId: 'pg-ro-read', sql: 'SELECT count(*) FROM sales.orders' });
      expect(read.results[0].rows[0][0]).toEqual({ t: 'int', v: '1500' });
    });

    it('disconnects when connection fields change', async () => {
      await api.call('connections.connect', { profileId: pgId });
      const p = (await api.call('connections.list', undefined)).find((x) => x.id === pgId)!;
      await api.call('connections.save', { profile: { ...p, color: '#112233' } });
      expect(services.registry.status({ profileId: pgId }).state).toBe('connected');
      await api.call('connections.save', { profile: { ...p, options: { connectTimeoutSec: '20' } } });
      expect(services.registry.status({ profileId: pgId }).state).toBe('disconnected');
    });
  });
});
