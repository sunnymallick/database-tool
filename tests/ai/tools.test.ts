import { describe, expect, it } from 'vitest';
import { WriteGrants } from '../../src/main/ai/approvals';
import {
  MAX_PAYLOAD_BYTES,
  MAX_ROWS,
  ToolHost,
  encodeResult,
  summarizeToolOutput,
  type ToolContext
} from '../../src/main/ai/tools';
import { fakeRegistry, int, makeProfile, queryFailure, resultSet, text } from './fakes';

function host(overrides: Partial<ToolContext> = {}, profile = makeProfile()) {
  const registry = fakeRegistry([profile]);
  const ctx: ToolContext = {
    registry,
    conn: { profileId: profile.id },
    profile,
    editor: null,
    allowWrites: false,
    grants: new WriteGrants(),
    signal: new AbortController().signal,
    ...overrides
  };
  return { host: new ToolHost(ctx), registry, driver: registry.driver, ctx };
}

const parse = (t: string) => JSON.parse(t) as Record<string, unknown>;

describe('run_select read-only enforcement', () => {
  it('runs a single SELECT with the 100-row cap', async () => {
    const { host: h, driver } = host();
    driver.responses.set('SELECT status, count(*) FROM orders GROUP BY 1', [
      resultSet(['status', 'count'], [[text('paid'), int(3)]])
    ]);
    const out = await h.call('run_select', { sql: 'SELECT status, count(*) FROM orders GROUP BY 1' });
    expect(out.isError).toBe(false);
    expect(parse(out.text)).toMatchObject({ rows: [['paid', 3]], row_count: 1 });
    expect(driver.executed[0].opts.rowCap).toBe(MAX_ROWS);
  });

  it.each([
    ['INSERT INTO orders (status) VALUES (1)'],
    ['update orders set status = 1'],
    ['DELETE FROM orders'],
    ['DROP TABLE orders'],
    ['TRUNCATE orders'],
    ['create table x (id int)']
  ])('rejects a write: %s', async (sql) => {
    const { host: h, driver } = host();
    const out = await h.call('run_select', { sql });
    expect(out.isError).toBe(true);
    expect(parse(out.text).error).toMatch(/read-only/);
    expect(driver.executed).toHaveLength(0);
  });

  it('rejects more than one statement, even if all are reads', async () => {
    const { host: h, driver } = host();
    const out = await h.call('run_select', { sql: 'SELECT 1; SELECT 2' });
    expect(out.isError).toBe(true);
    expect(parse(out.text).error).toMatch(/exactly one statement/);
    expect(driver.executed).toHaveLength(0);
  });

  it('rejects a read smuggling a write after a semicolon', async () => {
    const { host: h, driver } = host();
    const out = await h.call('run_select', { sql: 'SELECT 1; DELETE FROM orders' });
    expect(out.isError).toBe(true);
    expect(driver.executed).toHaveLength(0);
  });

  it('rejects empty and comment-only SQL', async () => {
    const { host: h } = host();
    expect((await h.call('run_select', { sql: '   ' })).isError).toBe(true);
    expect((await h.call('run_select', { sql: '-- nothing' })).isError).toBe(true);
  });

  it('returns engine errors as error content instead of throwing', async () => {
    const { host: h, driver } = host();
    driver.responses.set('SELECT nope FROM orders', queryFailure('column "nope" does not exist', '42703'));
    const out = await h.call('run_select', { sql: 'SELECT nope FROM orders' });
    expect(out.isError).toBe(true);
    expect(parse(out.text)).toMatchObject({ error: 'column "nope" does not exist', code: '42703' });
  });

  it('errors clearly when no database is selected', async () => {
    const { host: h } = host({ conn: null, profile: null });
    const out = await h.call('run_select', { sql: 'SELECT 1' });
    expect(out.isError).toBe(true);
    expect(parse(out.text).error).toMatch(/No database is selected/);
  });
});

describe('result payload caps', () => {
  it('caps rows at 100 and flags truncation', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [int(i), text(`row ${i}`)]);
    const enc = encodeResult(resultSet(['id', 'name'], rows));
    expect((enc.rows as unknown[]).length).toBe(MAX_ROWS);
    expect(enc.row_count).toBe(MAX_ROWS);
    expect(enc.truncated).toBe(true);
    expect(enc.note).toMatch(/More rows exist/);
  });

  it('passes on the driver-side truncation flag', () => {
    const enc = encodeResult(resultSet(['id'], [[int(1)]], { truncated: true }));
    expect(enc.truncated).toBe(true);
  });

  it('keeps the payload under 50 KB by dropping rows', () => {
    const big = 'x'.repeat(1_900);
    const rows = Array.from({ length: 100 }, (_, i) => [int(i), text(big)]);
    const enc = encodeResult(resultSet(['id', 'blob'], rows));
    const bytes = Buffer.byteLength(JSON.stringify(enc));
    expect(bytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect((enc.rows as unknown[]).length).toBeGreaterThan(10);
    expect((enc.rows as unknown[]).length).toBeLessThan(100);
    expect(enc.truncated).toBe(true);
    expect(enc.note).toMatch(/50000-byte/);
  });

  it('cuts very long cells and large binaries', () => {
    const enc = encodeResult(
      resultSet(
        ['t', 'b', 'small'],
        [[text('y'.repeat(10_000)), { t: 'bytes', hex: 'ab'.repeat(500), length: 500 }, { t: 'bytes', hex: 'abcd', length: 2 }]]
      )
    );
    const [t, b, small] = (enc.rows as unknown[][])[0];
    expect(String(t).length).toBeLessThan(2_100);
    expect(String(t)).toMatch(/\[\+8000 chars\]$/);
    expect(b).toBe('<500 bytes>');
    expect(small).toBe('\\xabcd');
  });

  it('includes rows_affected for DML', () => {
    expect(encodeResult(resultSet([], [], { rowsAffected: 7 }))).toMatchObject({ rows_affected: 7, row_count: 0 });
  });

  it('caps run_select output end to end', async () => {
    const { host: h, driver } = host();
    const rows = Array.from({ length: 100 }, (_, i) => [int(i), text('z'.repeat(1_500))]);
    driver.responses.set('SELECT * FROM big', [resultSet(['id', 'payload'], rows, { truncated: true })]);
    const out = await h.call('run_select', { sql: 'SELECT * FROM big' });
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(summarizeToolOutput('run_select', out.text, out.isError)).toMatch(/rows \(truncated\)/);
  });
});

describe('schema tools', () => {
  it('lists tables in the default schema', async () => {
    const { host: h } = host();
    const out = parse((await h.call('list_tables', {})).text);
    expect(out.schema).toBe('public');
    expect(out.tables).toEqual([{ name: 'orders', rows: 1500 }, { name: 'order_totals', kind: 'view' }]);
  });

  it('describes a table compactly', async () => {
    const { host: h } = host();
    const out = parse((await h.call('describe_table', { table: 'orders' })).text);
    expect(out.primary_key).toEqual(['id']);
    expect(out.columns).toEqual([
      { name: 'id', type: 'int4', nullable: false, pk: true, identity: true },
      { name: 'status', type: 'text', nullable: false, default: "'pending'" }
    ]);
  });

  it('reports a missing table as error content', async () => {
    const { host: h } = host();
    const out = await h.call('describe_table', { table: 'nope' });
    expect(out.isError).toBe(true);
    expect(parse(out.text).error).toMatch(/does not exist/);
  });
});

describe('run_statement gating inside the handler', () => {
  it('refuses on read-only profiles even with allow-writes on', async () => {
    const { host: h, driver } = host({ allowWrites: true }, makeProfile({ readOnly: true }));
    const out = await h.call('run_statement', { sql: 'DELETE FROM orders' });
    expect(out.isError).toBe(true);
    expect(parse(out.text).error).toMatch(/read-only/);
    expect(driver.executed).toHaveLength(0);
  });

  it('refuses an unapproved write when approval is required', async () => {
    const { host: h, driver } = host({ allowWrites: false });
    const out = await h.call('run_statement', { sql: 'DELETE FROM orders' });
    expect(out.isError).toBe(true);
    expect(parse(out.text).error).toMatch(/not approved/);
    expect(driver.executed).toHaveLength(0);
  });

  it('runs a write once per approval grant', async () => {
    const grants = new WriteGrants();
    const history: unknown[] = [];
    const { host: h, driver } = host({ grants, recordHistory: (sql, r) => history.push({ sql, ...r }) });
    grants.grant('DELETE FROM orders WHERE id = 1');
    const first = await h.call('run_statement', { sql: 'DELETE FROM orders WHERE id = 1' });
    expect(first.isError).toBe(false);
    expect(parse(first.text)).toEqual({ rows_affected: 1 });
    const second = await h.call('run_statement', { sql: 'DELETE FROM orders WHERE id = 1' });
    expect(second.isError).toBe(true);
    expect(driver.executed).toHaveLength(1);
    expect(history).toHaveLength(1);
  });

  it('production profiles need a grant even with allow-writes on', async () => {
    const { host: h, driver } = host({ allowWrites: true }, makeProfile({ production: true }));
    const out = await h.call('run_statement', { sql: 'UPDATE orders SET status = 1' });
    expect(out.isError).toBe(true);
    expect(driver.executed).toHaveLength(0);
  });

  it('runs without a grant when allow-writes is on for a normal profile', async () => {
    const { host: h, driver } = host({ allowWrites: true });
    const out = await h.call('run_statement', { sql: 'UPDATE orders SET status = 1' });
    expect(out.isError).toBe(false);
    expect(driver.executed).toHaveLength(1);
  });

  it('rejects multiple statements', async () => {
    const { host: h, driver } = host({ allowWrites: true });
    const out = await h.call('run_statement', { sql: 'DELETE FROM a; DELETE FROM b' });
    expect(out.isError).toBe(true);
    expect(driver.executed).toHaveLength(0);
  });
});

describe('editor and proposals', () => {
  it('read_editor errors when no editor was shared', async () => {
    const { host: h } = host();
    const out = await h.call('read_editor', {});
    expect(out.isError).toBe(true);
  });

  it('read_editor returns the snapshot', async () => {
    const { host: h } = host({
      editor: { tabId: 't1', title: 'Query 1', sql: 'select 1', selection: null, conn: { profileId: 'p1' } }
    });
    expect(parse((await h.call('read_editor', {})).text)).toEqual({
      title: 'Query 1',
      connection: 'Shop',
      sql: 'select 1',
      selection: null
    });
  });

  it('propose_sql never executes', async () => {
    const { host: h, driver } = host();
    const out = await h.call('propose_sql', { sql: 'DELETE FROM orders', explanation: 'x' });
    expect(out.isError).toBe(false);
    expect(parse(out.text)).toMatchObject({ shown: true, executed: false });
    expect(driver.executed).toHaveLength(0);
  });

  it('describeCall marks only gated writes as needing approval', () => {
    const { host: h } = host();
    expect(h.describeCall('run_statement', { sql: 'DELETE FROM x' })).toEqual({
      kind: 'write',
      preview: 'DELETE FROM x',
      needsApproval: true,
      production: false
    });
    expect(h.describeCall('run_select', { sql: 'SELECT 1' }).needsApproval).toBe(false);
    expect(h.describeCall('describe_table', { schema: 'public', table: 'orders' }).preview).toBe('public.orders');
  });
});
