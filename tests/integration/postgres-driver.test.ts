/**
 * Postgres driver against the local `database_tool_test` database (see
 * scripts/make-fixtures.ts). Fixture tables are only read; anything that
 * writes happens in a scratch schema created and dropped by this run.
 * Skipped when the server is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueryFailure, type Driver } from '../../src/main/db/driver';
import { connectDriver } from '../../src/main/db';
import { pgAdmin, pgAvailable, pgProfile } from './support';

const available = await pgAvailable();
const scratch = `dt_test_${process.pid}_${Date.now().toString(36)}`;

describe.skipIf(!available)('postgres driver (database_tool_test)', () => {
  let driver: Driver;

  beforeAll(async () => {
    await pgAdmin(`CREATE SCHEMA ${scratch}`);
    driver = await connectDriver(pgProfile(), null, pgProfile().database);
  });

  afterAll(async () => {
    await driver?.close();
    await pgAdmin(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
  });

  it('browses the catalog', async () => {
    expect(await driver.serverVersion()).toMatch(/^PostgreSQL \d+/);
    expect(await driver.listDatabases()).toContain('database_tool_test');
    const schemas = await driver.listSchemas();
    expect(schemas.schemas).toEqual(expect.arrayContaining(['public', 'sales']));
    expect(schemas.schemas).not.toContain('pg_catalog');
    expect(schemas.defaultSchema).toBe('public');

    const sales = await driver.listTables('sales');
    const kinds = Object.fromEntries(sales.map((t) => [t.name, t.kind]));
    expect(kinds).toMatchObject({ orders: 'table', order_items: 'table', customer_order_totals: 'view', daily_revenue: 'materialized_view' });
    const customers = (await driver.listTables('public')).find((t) => t.name === 'customers');
    expect(customers?.comment).toBe('People who have placed or may place orders');
    expect(customers?.rowEstimate).toBe(200);

    const routines = await driver.listRoutines('sales');
    expect(routines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'customer_lifetime_value', kind: 'function', signature: '(p_customer bigint)', returns: 'numeric' }),
        expect.objectContaining({ name: 'cancel_stale_orders', kind: 'procedure', signature: '(IN p_days integer)' })
      ])
    );
    // pgcrypto's functions live in public but belong to the extension.
    expect((await driver.listRoutines('public')).find((r) => r.name === 'gen_random_uuid')).toBeUndefined();
  });

  it('describes tables', async () => {
    const t = await driver.describeTable('public', 'customers');
    expect(t.primaryKey).toEqual(['id']);
    expect(t.comment).toBe('People who have placed or may place orders');
    const byName = Object.fromEntries(t.columns.map((c) => [c.name, c]));
    expect(byName.id).toMatchObject({ type: 'bigint', isPrimaryKey: true, isIdentity: true, nullable: false });
    expect(byName.external_id).toMatchObject({ type: 'uuid', comment: 'Stable id shared with the CRM', defaultValue: 'gen_random_uuid()' });
    expect(byName.tags.type).toBe('text[]');
    expect(t.indexes.find((i) => i.primary)).toMatchObject({ columns: ['id'], unique: true, method: 'btree' });
    expect(t.referencedBy).toEqual([expect.objectContaining({ schema: 'sales', table: 'orders', columns: ['customer_id'], refColumns: ['id'], onDelete: 'CASCADE' })]);

    const products = await driver.describeTable('public', 'products');
    expect(products.columns.find((c) => c.name === 'id')).toMatchObject({ isIdentity: true });
    expect(products.checks).toEqual([expect.objectContaining({ definition: expect.stringContaining('price >=') })]);

    const items = await driver.describeTable('sales', 'order_items');
    expect(items.primaryKey).toEqual(['order_id', 'product_id']);
    expect(items.foreignKeys.map((f) => `${f.refSchema}.${f.refTable}`).sort()).toEqual(['public.products', 'sales.orders']);

    const orders = await driver.describeTable('sales', 'orders');
    const statusIdx = orders.indexes.find((i) => i.name === 'idx_orders_status_placed');
    expect(statusIdx?.columns).toEqual(['status', 'placed_at']);
    expect(statusIdx?.definition).toContain('(status, placed_at DESC)');

    const mv = await driver.describeTable('sales', 'daily_revenue');
    expect(mv.kind).toBe('materialized_view');
    await expect(driver.describeTable('public', 'missing_table')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('produces DDL and routine definitions', async () => {
    const ddl = await driver.tableDdl('public', 'products');
    expect(ddl).toContain('CREATE TABLE "public"."products"');
    expect(ddl).toContain('GENERATED ALWAYS AS IDENTITY');
    expect(ddl).toMatch(/CONSTRAINT "products_pkey" PRIMARY KEY \(id\)/);
    const ordersDdl = await driver.tableDdl('sales', 'orders');
    expect(ordersDdl).toContain('CREATE INDEX idx_orders_status_placed');
    expect(ordersDdl).toContain('REFERENCES customers(id) ON DELETE CASCADE');
    expect(await driver.tableDdl('sales', 'customer_order_totals')).toMatch(/^CREATE OR REPLACE VIEW "sales"\."customer_order_totals" AS\n/);
    expect(await driver.tableDdl('sales', 'daily_revenue')).toMatch(/^CREATE MATERIALIZED VIEW/);
    const fn = await driver.routineDefinition('sales', 'customer_lifetime_value', 'function');
    expect(fn).toContain('CREATE OR REPLACE FUNCTION sales.customer_lifetime_value(p_customer bigint)');
    expect(await driver.routineDefinition('sales', 'cancel_stale_orders', 'procedure')).toContain('CREATE OR REPLACE PROCEDURE');
    await expect(driver.routineDefinition('sales', 'customer_lifetime_value', 'procedure')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps values without JS Dates or lossy numbers', async () => {
    const [r] = await driver.execute(
      `SELECT 9223372036854775807::int8 AS big, 12.50::numeric(10,2) AS dec, 1.5::float8 AS f, true AS b,
              '{"a":[1,2]}'::jsonb AS j, ARRAY[1,2,NULL]::int[] AS arr, ARRAY['x,y','z']::text[] AS tarr,
              '\\x00ff'::bytea AS bin, '2025-01-02 03:04:05.123456+00'::timestamptz AS ts, '1 day 02:00'::interval AS iv,
              'b5f2c1a0-0000-4000-8000-000000000000'::uuid AS u, 'paid'::sales.order_status AS status, NULL::text AS n, 'NaN'::float8 AS nan`,
      { rowCap: 10 }
    );
    const byName = Object.fromEntries(r.columns.map((c, i) => [c.name, { type: c.type, value: r.rows[0][i] }]));
    expect(byName.big).toEqual({ type: 'int8', value: { t: 'int', v: '9223372036854775807' } });
    expect(byName.dec.value).toEqual({ t: 'decimal', v: '12.50' });
    expect(byName.f.value).toEqual({ t: 'float', v: 1.5 });
    expect(byName.b.value).toEqual({ t: 'bool', v: true });
    expect(byName.j.value).toEqual({ t: 'json', v: { a: [1, 2] } });
    expect(byName.arr).toEqual({ type: 'int4[]', value: { t: 'json', v: [1, 2, null] } });
    expect(byName.tarr.value).toEqual({ t: 'json', v: ['x,y', 'z'] });
    expect(byName.bin.value).toEqual({ t: 'bytes', hex: '00ff', length: 2 });
    expect(byName.ts.value.t).toBe('datetime');
    expect((byName.ts.value as { v: string }).v).toMatch(/^2025-01-0[12] \d\d:04:05\.123456[+-]\d\d/);
    expect(byName.iv.value).toEqual({ t: 'datetime', v: '1 day 02:00:00' });
    expect(byName.u.value).toEqual({ t: 'text', v: 'b5f2c1a0-0000-4000-8000-000000000000' });
    expect(byName.status).toEqual({ type: 'order_status', value: { t: 'text', v: 'paid' } });
    expect(byName.n.value).toEqual({ t: 'null' });
    expect(Number.isNaN((byName.nan.value as { v: number }).v)).toBe(true);
  });

  it('caps rows without breaking the session or an open transaction', async () => {
    const [capped] = await driver.execute('SELECT g FROM generate_series(1, 100000) g', { rowCap: 25 });
    expect(capped.rows).toHaveLength(25);
    expect(capped.truncated).toBe(true);
    const [exact] = await driver.execute('SELECT g FROM generate_series(1, 25) g', { rowCap: 25 });
    expect(exact.truncated).toBe(false);

    const results = await driver.execute('BEGIN; SELECT * FROM sales.orders; SELECT count(*) FROM sales.orders; COMMIT', { rowCap: 5 });
    expect(results.map((r) => r.rows.length)).toEqual([0, 5, 1, 0]);
    expect(results[1].truncated).toBe(true);
    expect(results[2].rows[0][0]).toEqual({ t: 'int', v: '1500' });
  });

  it('persists session state (SET, temp tables, transactions) across runs', async () => {
    await driver.execute(`SET search_path TO sales, public`, { rowCap: 10 });
    const [r] = await driver.execute('SELECT count(*) FROM orders', { rowCap: 10 });
    expect(r.rows[0][0]).toEqual({ t: 'int', v: '1500' });
    await driver.execute('CREATE TEMP TABLE tmp_session (x int); INSERT INTO tmp_session VALUES (1)', { rowCap: 10 });
    await driver.execute('BEGIN', { rowCap: 10 });
    await driver.execute('INSERT INTO tmp_session VALUES (2)', { rowCap: 10 });
    await driver.execute('ROLLBACK', { rowCap: 10 });
    const [t] = await driver.execute('SELECT count(*) FROM tmp_session', { rowCap: 10 });
    expect(t.rows[0][0]).toEqual({ t: 'int', v: '1' });
    await driver.execute('RESET search_path; DROP TABLE tmp_session', { rowCap: 10 });
  });

  it('reports errors with partial results, codes, and script offsets', async () => {
    const sql = 'SELECT 1;\n\nSELECT * FROM public.customers WHERE nosuchcol = 1;\nSELECT 3';
    const err = await driver.execute(sql, { rowCap: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryFailure);
    const f = err as QueryFailure;
    expect(f.partial).toHaveLength(1);
    expect(f.error).toMatchObject({ code: '42703', statementIndex: 1, position: sql.indexOf('nosuchcol') });
    // Characters outside the BMP count once for the server but twice in JS strings.
    const emoji = "SELECT '😀😀', nope";
    const e2 = (await driver.execute(emoji, { rowCap: 10 }).catch((e: unknown) => e)) as QueryFailure;
    expect(e2.error.position).toBe(emoji.indexOf('nope'));
  });

  it('collects notices and rowsAffected', async () => {
    const [notice] = await driver.execute(`DO $$ BEGIN RAISE NOTICE 'hello %', 42; END $$`, { rowCap: 10 });
    expect(notice.messages).toEqual(['NOTICE: hello 42']);
    const results = await driver.execute(
      `CREATE TABLE ${scratch}.t (id int PRIMARY KEY, v text); INSERT INTO ${scratch}.t SELECT g, 'v' || g FROM generate_series(1, 3) g; UPDATE ${scratch}.t SET v = 'x' WHERE id > 1 RETURNING id`,
      { rowCap: 10 }
    );
    expect(results[0].rowsAffected).toBeUndefined();
    expect(results[1].rowsAffected).toBe(3);
    expect(results[2]).toMatchObject({ rowsAffected: 2 });
    expect(results[2].rows).toHaveLength(2);
  });

  it('cancels a running statement server-side', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    const err = await driver.execute('SELECT pg_sleep(10)', { rowCap: 10, signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryFailure);
    // Every engine reports a user cancel the same way.
    expect((err as QueryFailure).error.code).toBe('CANCELLED');
    expect(Date.now() - started).toBeLessThan(5000);
    const [ok] = await driver.execute('SELECT 1 AS still_alive', { rowCap: 10 });
    expect(ok.rows[0][0]).toEqual({ t: 'int', v: '1' });
  });

  it('pages, counts, and edits rows in the scratch schema', async () => {
    await driver.execute(
      `CREATE TABLE ${scratch}.items (id int PRIMARY KEY, name text NOT NULL, price numeric(10,2), data jsonb, blob bytea, flag boolean DEFAULT false);
       INSERT INTO ${scratch}.items SELECT g, 'item ' || g, g * 1.5, jsonb_build_object('g', g), NULL, false FROM generate_series(1, 30) g`,
      { rowCap: 10 }
    );
    const page = await driver.fetchRows({ schema: scratch, table: 'items', where: 'price > 3', orderBy: [{ column: 'id', desc: true }], limit: 5, offset: 5, countTotal: true });
    expect(page.primaryKey).toEqual(['id']);
    expect(page.total).toBe(28);
    expect(page.result.rows.map((r) => (r[0] as { v: string }).v)).toEqual(['25', '24', '23', '22', '21']);
    await expect(driver.fetchRows({ schema: scratch, table: 'items', where: '1=1; DROP TABLE x', limit: 5, offset: 0 })).rejects.toThrow();

    const changes = {
      updates: [{ pk: { id: { t: 'int', v: '1' } as const }, set: { name: { t: 'text', v: "O'Brien" } as const, data: { t: 'json', v: [1, 'two'] } as const, blob: { t: 'bytes', hex: '00ff', length: 2 } as const } }],
      inserts: [{ id: { t: 'int', v: '100' } as const, name: { t: 'text', v: 'new' } as const, price: { t: 'decimal', v: '9.99' } as const }],
      deletes: [{ id: { t: 'int', v: '30' } as const }]
    };
    const preview = await driver.applyChanges(scratch, 'items', changes, { preview: true });
    expect(preview.applied).toBe(0);
    expect(preview.statements).toEqual([
      `DELETE FROM "${scratch}"."items" WHERE "id" = 30`,
      `UPDATE "${scratch}"."items" SET "name" = 'O''Brien', "data" = '[1,"two"]', "blob" = '\\x00ff'::bytea WHERE "id" = 1`,
      `INSERT INTO "${scratch}"."items" ("id", "name", "price") VALUES (100, 'new', 9.99)`
    ]);
    const applied = await driver.applyChanges(scratch, 'items', changes, { preview: false });
    expect(applied.applied).toBe(3);
    const [check] = await driver.execute(`SELECT name, data, blob, (SELECT count(*) FROM ${scratch}.items) FROM ${scratch}.items WHERE id = 1`, { rowCap: 10 });
    expect(check.rows[0]).toEqual([
      { t: 'text', v: "O'Brien" },
      { t: 'json', v: [1, 'two'] },
      { t: 'bytes', hex: '00ff', length: 2 },
      { t: 'int', v: '30' }
    ]);

    const missing = { updates: [{ pk: { id: { t: 'int', v: '2' } as const }, set: { name: { t: 'text', v: 'nope' } as const } }], inserts: [], deletes: [{ id: { t: 'int', v: '9999' } as const }] };
    await expect(driver.applyChanges(scratch, 'items', missing, { preview: false })).rejects.toMatchObject({ code: 'ROW_MISMATCH' });
    const [still] = await driver.execute(`SELECT name FROM ${scratch}.items WHERE id = 2`, { rowCap: 1 });
    expect(still.rows[0][0]).toEqual({ t: 'text', v: 'item 2' });
  });

  it('builds completion metadata with a cap', async () => {
    const meta = await driver.fetchMeta();
    expect(meta.defaultSchema).toBe('public');
    expect(meta.tables[0].schema).toBe('public');
    expect(meta.tables.find((t) => t.schema === 'sales' && t.name === 'orders')?.columns.map((c) => c.name)).toContain('placed_at');
    const capped = await driver.fetchMeta({ maxTables: 3 });
    expect(capped.tables).toHaveLength(3);
    expect(capped.truncated).toBe(true);
  });

  it('refuses writes server-side on read-only connections', async () => {
    const ro = await connectDriver(pgProfile(), null, pgProfile().database, { readOnly: true });
    try {
      const err = (await ro.execute(`CREATE TABLE ${scratch}.nope (x int)`, { rowCap: 10 }).catch((e: unknown) => e)) as QueryFailure;
      expect(err.error.code).toBe('25006');
    } finally {
      await ro.close();
    }
  });
});
