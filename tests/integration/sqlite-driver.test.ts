import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryFailure, type Driver } from '../../src/main/db/driver';
import { connectDriver } from '../../src/main/db';
import { profile, sqliteCopy, tempDir } from './support';

describe('sqlite driver (temp copy of tests/fixtures/sample.sqlite)', () => {
  const tmp = tempDir('sqlite-driver');
  let driver: Driver;

  beforeAll(async () => {
    driver = await connectDriver(profile('sqlite', { filePath: sqliteCopy(tmp.dir) }), null, '');
  });

  afterAll(async () => {
    await driver?.close();
    tmp.cleanup();
  });

  it('reports a version and lists schemas and tables', async () => {
    expect(await driver.serverVersion()).toMatch(/^SQLite 3\./);
    expect(await driver.listSchemas()).toEqual({ schemas: ['main'], defaultSchema: 'main' });
    const tables = await driver.listTables('main');
    expect(tables.map((t) => `${t.name}:${t.kind}`)).toEqual([
      'customer_order_totals:view',
      'customers:table',
      'event_log:table',
      'order_items:table',
      'orders:table',
      'products:table'
    ]);
    expect(await driver.listRoutines('main')).toEqual([]);
    expect(await driver.listDatabases()).toEqual([]);
  });

  it('runs scripts statement by statement with typed values', async () => {
    const results = await driver.execute('SELECT id, email, is_active, metadata FROM customers ORDER BY id LIMIT 2; SELECT price, image FROM products WHERE image IS NOT NULL ORDER BY id LIMIT 1', {
      rowCap: 100
    });
    expect(results).toHaveLength(2);
    const [customers, products] = results;
    expect(customers.statementIndex).toBe(0);
    expect(customers.columns.map((c) => `${c.name}:${c.type}`)).toEqual(['id:INTEGER', 'email:TEXT', 'is_active:BOOLEAN', 'metadata:JSON']);
    expect(customers.rows[0][0]).toEqual({ t: 'int', v: '1' });
    expect(customers.rows[0][2].t).toBe('bool');
    expect(['json', 'null']).toContain(customers.rows[0][3].t);
    expect(products.statementIndex).toBe(1);
    expect(products.rows[0][0].t).toBe('decimal');
    expect(products.rows[0][1]).toMatchObject({ t: 'bytes', length: 24 });
  });

  it('enforces the row cap while reading', async () => {
    const [capped] = await driver.execute('SELECT * FROM orders', { rowCap: 10 });
    expect(capped.rows).toHaveLength(10);
    expect(capped.truncated).toBe(true);
    const [exact] = await driver.execute('SELECT * FROM orders LIMIT 10', { rowCap: 10 });
    expect(exact.truncated).toBe(false);
    const [all] = await driver.execute('SELECT * FROM orders', { rowCap: 0 });
    expect(all.rows).toHaveLength(1500);
  });

  it('keeps 64-bit integers exact', async () => {
    const [r] = await driver.execute('SELECT 9223372036854775807 AS big', { rowCap: 10 });
    expect(r.rows[0][0]).toEqual({ t: 'int', v: '9223372036854775807' });
    expect(r.columns[0].type).toBe('INTEGER');
  });

  it('throws QueryFailure with partial results and a script offset', async () => {
    const sql = 'SELECT 1;\nSELEC 2;\nSELECT 3';
    const err = await driver.execute(sql, { rowCap: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryFailure);
    const f = err as QueryFailure;
    expect(f.partial).toHaveLength(1);
    expect(f.error.statementIndex).toBe(1);
    expect(f.error.position).toBe(sql.indexOf('SELEC 2'));
    expect(f.error.message).toMatch(/syntax error/);
  });

  it('keeps session state and transactions across runs', async () => {
    await driver.execute('CREATE TEMP TABLE scratch (x INTEGER)', { rowCap: 10 });
    await driver.execute('BEGIN; INSERT INTO scratch VALUES (1), (2)', { rowCap: 10 });
    const [r] = await driver.execute('SELECT count(*) FROM scratch', { rowCap: 10 });
    expect(r.rows[0][0]).toEqual({ t: 'int', v: '2' });
    await driver.execute('ROLLBACK', { rowCap: 10 });
    const [after] = await driver.execute('SELECT count(*) FROM scratch', { rowCap: 10 });
    expect(after.rows[0][0]).toEqual({ t: 'int', v: '0' });
    expect((await driver.listSchemas()).schemas).toEqual(['main', 'temp']);
  });

  it('reports rowsAffected for writes only', async () => {
    const [ins] = await driver.execute("INSERT INTO event_log VALUES ('2025-01-01', 'info', 'x'), ('2025-01-01', 'info', 'y')", { rowCap: 10 });
    expect(ins.rowsAffected).toBe(2);
    expect(ins.columns).toEqual([]);
    const [ddl] = await driver.execute('CREATE TABLE t_ddl (a)', { rowCap: 10 });
    expect(ddl.rowsAffected).toBeUndefined();
  });

  it('describes tables with keys, indexes, foreign keys, and checks', async () => {
    const orders = await driver.describeTable('main', 'orders');
    expect(orders.primaryKey).toEqual(['id']);
    expect(orders.columns.find((c) => c.name === 'id')).toMatchObject({ isPrimaryKey: true, isIdentity: true, nullable: false });
    expect(orders.columns.find((c) => c.name === 'total')).toMatchObject({ type: 'NUMERIC(12,2)', defaultValue: '0' });
    expect(orders.indexes.map((i) => i.name).sort()).toEqual(['idx_orders_customer', 'idx_orders_status_placed']);
    expect(orders.foreignKeys).toEqual([
      expect.objectContaining({ table: 'orders', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE' })
    ]);
    expect(orders.referencedBy).toEqual([expect.objectContaining({ table: 'order_items', columns: ['order_id'], refColumns: ['id'] })]);
    expect(orders.checks).toHaveLength(1);
    expect(orders.checks[0].definition).toContain("status IN ('pending'");

    const items = await driver.describeTable('main', 'order_items');
    expect(items.primaryKey).toEqual(['order_id', 'product_id']);
    expect(items.columns.every((c) => !c.isIdentity)).toBe(true);
    expect(items.indexes.find((i) => i.primary)?.columns).toEqual(['order_id', 'product_id']);

    const view = await driver.describeTable('main', 'customer_order_totals');
    expect(view.kind).toBe('view');
    expect(view.primaryKey).toEqual([]);
    await expect(driver.describeTable('main', 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns stored DDL including indexes and triggers', async () => {
    const ddl = await driver.tableDdl('main', 'order_items');
    expect(ddl).toContain('CREATE TABLE order_items');
    expect(ddl).toContain('CREATE TRIGGER trg_order_items_stock');
  });

  it('pages rows with filters, sorting, and counts', async () => {
    const page = await driver.fetchRows({ schema: 'main', table: 'orders', where: "status = 'paid'", orderBy: [{ column: 'total', desc: true }], limit: 5, offset: 0, countTotal: true });
    expect(page.result.rows).toHaveLength(5);
    expect(page.primaryKey).toEqual(['id']);
    expect(page.total).toBeGreaterThan(5);
    const totals = page.result.rows.map((r) => Number((r[3] as { v: string }).v));
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    const defaultOrder = await driver.fetchRows({ schema: 'main', table: 'customers', limit: 3, offset: 2 });
    expect(defaultOrder.result.rows.map((r) => (r[0] as { v: string }).v)).toEqual(['3', '4', '5']);
    expect(defaultOrder.total).toBeNull();
  });

  it('applies and previews row changes in one transaction', async () => {
    const changes = {
      updates: [{ pk: { id: { t: 'int', v: '1' } as const }, set: { notes: { t: 'text', v: "it's done" } as const } }],
      inserts: [{ happened_at: { t: 'text', v: '2025-02-02' } as const, level: { t: 'text', v: 'warn' } as const, message: { t: 'text', v: 'z' } as const }],
      deletes: []
    };
    const preview = await driver.applyChanges('main', 'orders', { updates: changes.updates, inserts: [], deletes: [] }, { preview: true });
    expect(preview).toEqual({ statements: [`UPDATE "main"."orders" SET "notes" = 'it''s done' WHERE "id" = 1`], applied: 0 });
    const applied = await driver.applyChanges('main', 'orders', { updates: changes.updates, inserts: [], deletes: [] }, { preview: false });
    expect(applied.applied).toBe(1);
    const [r] = await driver.execute('SELECT notes FROM orders WHERE id = 1', { rowCap: 1 });
    expect(r.rows[0][0]).toEqual({ t: 'text', v: "it's done" });

    await expect(driver.applyChanges('main', 'event_log', { updates: [], inserts: changes.inserts, deletes: [] }, { preview: false })).rejects.toMatchObject({ code: 'NO_PRIMARY_KEY' });

    // A missing row rolls back the whole batch, including the update that matched.
    const bad = {
      updates: [{ pk: { id: { t: 'int', v: '2' } as const }, set: { notes: { t: 'text', v: 'should roll back' } as const } }],
      inserts: [],
      deletes: [{ id: { t: 'int', v: '999999' } as const }]
    };
    await expect(driver.applyChanges('main', 'orders', bad, { preview: false })).rejects.toMatchObject({ code: 'ROW_MISMATCH' });
    const [r2] = await driver.execute('SELECT notes FROM orders WHERE id = 2', { rowCap: 1 });
    expect(r2.rows[0][0]).not.toEqual({ t: 'text', v: 'should roll back' });
  });

  it('builds completion metadata', async () => {
    const meta = await driver.fetchMeta();
    expect(meta.defaultSchema).toBe('main');
    expect(meta.tables.find((t) => t.name === 'customers')?.columns.map((c) => c.name)).toContain('email');
    const capped = await driver.fetchMeta({ maxTables: 2 });
    expect(capped.tables).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('cancels between statements', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await driver.execute('SELECT 1; SELECT 2', { rowCap: 10, signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryFailure);
    expect((err as QueryFailure).error.code).toBe('CANCELLED');
  });

  it('opens read-only when asked', async () => {
    const ro = await connectDriver(profile('sqlite', { filePath: sqliteCopy(tmp.dir) }), null, '', { readOnly: true });
    try {
      const err = await ro.execute("DELETE FROM event_log", { rowCap: 10 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QueryFailure);
      expect((err as QueryFailure).error.message).toMatch(/readonly/);
    } finally {
      await ro.close();
    }
  });
});
