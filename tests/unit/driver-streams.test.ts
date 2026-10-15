/**
 * MySQL and SQL Server cannot be integration-tested here, so their streaming
 * execution paths (multiple result sets, row cap with server-side stop vs
 * drain, messages, errors, cancel) run against scripted fakes of the
 * mysql2 Connection and mssql Request event streams.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryFailure } from '../../src/main/db/driver';
import { MssqlDriver, rowCells } from '../../src/main/db/mssql';
import { MysqlDriver, mysqlConnectionOptions } from '../../src/main/db/mysql';
import { MYSQL_TYPES } from '../../src/main/db/mysql-values';
import { profile } from '../integration/support';

type Step = [event: string, ...args: unknown[]];

/** Emit steps on the next ticks, like a socket would. */
function play(emitter: EventEmitter, steps: Step[]): void {
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    const [event, ...args] = steps[i++];
    emitter.emit(event, ...args);
    setImmediate(next);
  };
  setImmediate(next);
}

// -- MySQL ------------------------------------------------------------------------

const field = (name: string, columnType: number, extra: Record<string, unknown> = {}) => ({ name, columnType, characterSet: 255, flags: 0, columnLength: 11, ...extra });
const ok = (affectedRows: number, extra: Record<string, unknown> = {}) => ({ affectedRows, warningStatus: 0, info: '', serverStatus: 2, ...extra });
const buf = (s: string) => Buffer.from(s);

class FakeMysqlConnection extends EventEmitter {
  threadId = 77;
  readonly sent: string[] = [];
  last: EventEmitter = new EventEmitter();
  constructor(private readonly scripts: Record<string, Step[]>) {
    super();
  }
  query(arg: unknown, cb?: (err: unknown, rows?: unknown) => void): EventEmitter {
    const sql = typeof arg === 'string' ? arg : (arg as { sql: string }).sql;
    this.sent.push(sql);
    const q = new EventEmitter();
    this.last = q;
    if (cb) {
      setImmediate(() => cb(null, sql === 'SHOW WARNINGS' ? [{ Level: 'Warning', Code: 1265, Message: "Data truncated for column 'a'" }] : []));
      return q;
    }
    play(q, this.scripts[sql] ?? [['end']]);
    return q;
  }
  end(cb: () => void): void {
    cb();
  }
}

function mysqlWith(conn: FakeMysqlConnection) {
  type Internals = { session: unknown; threadId: number; killQuery: (id: number) => Promise<void> };
  const Ctor = MysqlDriver as unknown as new (options: unknown, readOnly: boolean, database: string) => MysqlDriver;
  const driver = new Ctor(mysqlConnectionOptions(profile('mysql', { host: 'mysql.invalid' }), null, 'app', {}), false, 'app');
  const internals = driver as unknown as Internals;
  internals.session = conn;
  internals.threadId = conn.threadId;
  const kill = vi.fn(async () => undefined);
  internals.killQuery = kill;
  return { driver, kill };
}

describe('mysql execution (scripted connection)', () => {
  it('reads result sets, OK packets, warnings, and CALL results', async () => {
    const conn = new FakeMysqlConnection({
      'SELECT id, name FROM t': [['fields', [field('id', MYSQL_TYPES.LONGLONG), field('name', MYSQL_TYPES.VAR_STRING)]], ['result', [buf('1'), buf('a')], 0], ['result', [buf('2'), null], 0], ['end']],
      "INSERT INTO t VALUES (3, 'xx')": [['fields', undefined], ['result', ok(1, { warningStatus: 1, info: 'Records: 1  Duplicates: 0  Warnings: 1' })], ['end']],
      'CALL two_sets()': [
        ['fields', [field('a', MYSQL_TYPES.LONG)]],
        ['result', [buf('1')], 0],
        ['fields', [field('b', MYSQL_TYPES.JSON, { characterSet: 63 })]],
        ['result', [buf('{"k":true}')], 1],
        ['fields', undefined],
        ['result', ok(0)],
        ['end']
      ]
    });
    const { driver } = mysqlWith(conn);
    const results = await driver.execute("SELECT id, name FROM t; INSERT INTO t VALUES (3, 'xx'); CALL two_sets()", { rowCap: 100 });
    expect(results.map((r) => [r.statementIndex, r.columns.map((c) => c.name).join(',')])).toEqual([
      [0, 'id,name'],
      [1, ''],
      [2, 'a'],
      [2, 'b']
    ]);
    expect(results[0].rows).toEqual([
      [{ t: 'int', v: '1' }, { t: 'text', v: 'a' }],
      [{ t: 'int', v: '2' }, { t: 'null' }]
    ]);
    expect(results[0].columns[0].type).toBe('BIGINT');
    expect(results[1]).toMatchObject({ rowsAffected: 1, messages: ['Records: 1  Duplicates: 0  Warnings: 1', "Warning 1265: Data truncated for column 'a'"] });
    expect(results[3].rows[0][0]).toEqual({ t: 'json', v: { k: true } });
    expect(conn.sent).toContain('SHOW WARNINGS');
    await driver.close();
  });

  it('stops reads at the cap with KILL QUERY and drains writes instead', async () => {
    const rows: Step[] = Array.from({ length: 5 }, (_, i) => ['result', [buf(String(i))], 0] as Step);
    const conn = new FakeMysqlConnection({
      'SELECT n FROM big': [['fields', [field('n', MYSQL_TYPES.LONG)]], ...rows, ['error', { errno: 1317, message: 'Query execution was interrupted' }], ['end']],
      'CALL fill()': [['fields', [field('n', MYSQL_TYPES.LONG)]], ...rows, ['fields', undefined], ['result', ok(5)], ['end']]
    });
    const { driver, kill } = mysqlWith(conn);
    const [read] = await driver.execute('SELECT n FROM big', { rowCap: 2 });
    expect(read.rows).toHaveLength(2);
    expect(read.truncated).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(77);
    expect(read.messages).toEqual(['Row cap reached; the server was asked to stop the statement.']);

    const [write] = await driver.execute('CALL fill()', { rowCap: 2 });
    expect(write.truncated).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    await driver.close();
  });

  it('settles when the connection drops mid-statement instead of hanging', async () => {
    const conn = new FakeMysqlConnection({ 'SELECT SLEEP(60)': [['fields', [field('s', MYSQL_TYPES.LONGLONG)]]] });
    const { driver } = mysqlWith(conn);
    const running = driver.execute('SELECT SLEEP(60)', { rowCap: 10 });
    await new Promise((r) => setTimeout(r, 10));
    conn.emit('error', Object.assign(new Error('read ECONNRESET'), { fatal: true, code: 'ECONNRESET' }));
    const err = (await running.catch((e: unknown) => e)) as QueryFailure;
    expect(err).toBeInstanceOf(QueryFailure);
    expect(err.error).toMatchObject({ message: 'read ECONNRESET', code: 'ECONNRESET' });
    expect(conn.listenerCount('error')).toBe(0);
    await driver.close();
  });

  it('fails with partial results, MySQL codes, and positions; cancels with KILL QUERY', async () => {
    const conn = new FakeMysqlConnection({
      'SELECT 1': [['fields', [field('1', MYSQL_TYPES.LONGLONG)]], ['result', [buf('1')], 0], ['end']],
      'SELEC 2': [['error', { errno: 1064, code: 'ER_PARSE_ERROR', sqlState: '42000', sqlMessage: "You have an error in your SQL syntax; check the manual near 'SELEC 2' at line 1" }], ['end']],
      // Runs until KILL QUERY arrives.
      'SELECT SLEEP(10)': [['fields', [field('s', MYSQL_TYPES.LONGLONG)]]]
    });
    const { driver, kill } = mysqlWith(conn);
    kill.mockImplementation(async () => {
      conn.last.emit('error', { errno: 1317, message: 'Query execution was interrupted' });
      conn.last.emit('end');
    });
    const sql = 'SELECT 1;\nSELEC 2';
    const err = (await driver.execute(sql, { rowCap: 10 }).catch((e: unknown) => e)) as QueryFailure;
    expect(err).toBeInstanceOf(QueryFailure);
    expect(err.partial).toHaveLength(1);
    expect(err.error).toMatchObject({ code: '1064', statementIndex: 1, position: sql.indexOf('SELEC 2') });

    const controller = new AbortController();
    const running = driver.execute('SELECT SLEEP(10)', { rowCap: 10, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const cancelled = (await running.catch((e: unknown) => e)) as QueryFailure;
    expect(cancelled.error.code).toBe('CANCELLED');
    expect(kill).toHaveBeenCalledWith(77);
    await driver.close();
  });
});

// -- SQL Server ------------------------------------------------------------------

const col = (name: string, declaration: string, scale?: number) => ({ name, type: { declaration }, ...(scale !== undefined ? { scale } : {}) });

class FakeRequest extends EventEmitter {
  stream = false;
  arrayRowMode = false;
  cancelled = 0;
  private steps: Step[] = [];
  constructor(private readonly scripts: Record<string, Step[]>) {
    super();
  }
  batch(text: string, cb?: () => void): void | Promise<{ recordset: unknown[] }> {
    // Promise form (non-stream): a single scripted recordset.
    if (!cb) return Promise.resolve({ recordset: (this.scripts[text]?.[0]?.[1] as unknown[]) ?? [] });
    this.steps = this.scripts[text] ?? [];
    play(this, [...this.steps, ['done', {}]]);
    this.once('done', () => cb());
  }
  query(text: string): Promise<{ recordset: unknown[] }> {
    return Promise.resolve({ recordset: (this.scripts[text]?.[0]?.[1] as unknown[]) ?? [] });
  }
  cancel(): void {
    this.cancelled++;
    this.emit('error', Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
  }
}

function mssqlWith(scripts: Record<string, Step[]>, counter = { logins: 0, seen: 0 }) {
  const requests: FakeRequest[] = [];
  const pool = {
    request: () => {
      const r = new FakeRequest(scripts);
      requests.push(r);
      return r;
    },
    close: async () => undefined
  };
  const Ctor = MssqlDriver as unknown as new (session: unknown, browse: unknown, database: string, counter: unknown) => MssqlDriver;
  return { driver: new Ctor(pool, pool, 'Orders', counter), requests };
}

describe('mssql execution (scripted request stream)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs GO batches with multiple recordsets, PRINT messages, and row counts', async () => {
    const { driver, requests } = mssqlWith({
      "DECLARE @n int = 2\nPRINT 'starting'\nSELECT @n AS n, CAST(1 AS bit) AS b\nSELECT name FROM sys.objects": [
        ['info', { message: 'starting' }],
        ['recordset', [col('n', 'int'), col('b', 'bit')]],
        ['row', [2, true]],
        ['rowsaffected', 1],
        ['recordset', [col('name', 'nvarchar')]],
        ['row', ['a']],
        ['row', ['b']],
        ['rowsaffected', 2]
      ],
      'UPDATE t SET x = 1': [['rowsaffected', 3]],
      'SELECT 1 AS j FOR JSON PATH': [['recordset', [col('JSON_F52E2B61-18A1-11d1-B105-00805F49916B', 'nvarchar')]], ['row', { 0: '[{"j":1}]' }]]
    });
    const script = "DECLARE @n int = 2\nPRINT 'starting'\nSELECT @n AS n, CAST(1 AS bit) AS b\nSELECT name FROM sys.objects\nGO\nUPDATE t SET x = 1\nGO 2\nSELECT 1 AS j FOR JSON PATH";
    const results = await driver.execute(script, { rowCap: 100 });
    expect(requests.every((r) => r.stream && r.arrayRowMode)).toBe(true);
    expect(results.map((r) => r.statementIndex)).toEqual([0, 0, 1, 1, 2]);
    expect(results[0].rows).toEqual([[{ t: 'int', v: '2' }, { t: 'bool', v: true }]]);
    expect(results[1].rows).toHaveLength(2);
    expect(results[1].messages).toEqual(['starting', '(1 row affected)', '(2 rows affected)']);
    expect(results[2]).toMatchObject({ columns: [], rowsAffected: 3, messages: ['(3 rows affected)'] });
    expect(results[4].rows[0][0]).toEqual({ t: 'json', v: [{ j: 1 }] });
  });

  it('cancels read-only batches at the cap but drains batches that write', async () => {
    const rows: Step[] = Array.from({ length: 6 }, (_, i) => ['row', [i]] as Step);
    const { driver, requests } = mssqlWith({
      'SELECT n FROM big': [['recordset', [col('n', 'int')]], ...rows],
      'SELECT n FROM big\nDELETE FROM staging': [['recordset', [col('n', 'int')]], ...rows, ['rowsaffected', 6], ['rowsaffected', 4]]
    });
    const [read] = await driver.execute('SELECT n FROM big', { rowCap: 3 });
    expect(read.rows).toHaveLength(3);
    expect(read.truncated).toBe(true);
    expect(read.messages).toContain('Row cap reached; the rest of this batch was cancelled.');
    expect(requests[0].cancelled).toBe(1);

    const [mixed] = await driver.execute('SELECT n FROM big\nDELETE FROM staging', { rowCap: 3 });
    expect(mixed.truncated).toBe(true);
    expect(requests[1].cancelled).toBe(0);
    expect(mixed.messages).toEqual(['(6 rows affected)', '(4 rows affected)']);
  });

  it('drains instead of cancelling once the session has used transactions', async () => {
    const rows: Step[] = Array.from({ length: 6 }, (_, i) => ['row', [i]] as Step);
    const { driver, requests } = mssqlWith({
      'BEGIN TRAN': [],
      'SELECT n FROM big': [['recordset', [col('n', 'int')]], ...rows]
    });
    await driver.execute('BEGIN TRAN', { rowCap: 3 });
    const [read] = await driver.execute('SELECT n FROM big', { rowCap: 3 });
    expect(read.truncated).toBe(true);
    expect(read.rows).toHaveLength(3);
    expect(requests.every((r) => r.cancelled === 0)).toBe(true);
  });

  it('does not claim a reconnect when the first run used no connection', async () => {
    const counter = { logins: 0, seen: 0 };
    const { driver } = mssqlWith({ 'SELECT 1 AS a': [['recordset', [col('a', 'int')]], ['row', [1]]] }, counter);
    expect(await driver.execute('-- nothing to run', { rowCap: 10 })).toEqual([]);
    counter.logins = 1;
    const [first] = await driver.execute('SELECT 1 AS a', { rowCap: 10 });
    expect(first.messages).toBeUndefined();
  });

  it('reports the session schema and a console USE through sessionContext', async () => {
    const browseDb = [['recordset', [{ db: 'Orders' }]]] as Step[];
    const same = mssqlWith({ 'SELECT DB_NAME() AS db': browseDb, 'SELECT DB_NAME() AS db, SCHEMA_NAME() AS s': [['recordset', [{ db: 'orders', s: 'sales' }]]] });
    expect(await same.driver.sessionContext?.()).toEqual({ searchPath: ['sales', 'dbo'], switchedDatabase: false });
    const used = mssqlWith({ 'SELECT DB_NAME() AS db': browseDb, 'SELECT DB_NAME() AS db, SCHEMA_NAME() AS s': [['recordset', [{ db: 'Tenant2', s: 'dbo' }]]] });
    expect(await used.driver.sessionContext?.()).toEqual({ searchPath: ['dbo'], switchedDatabase: true });
  });

  it('reports errors with batch line positions and keeps results produced before them', async () => {
    const { driver } = mssqlWith({
      'SELECT 1 AS a': [['recordset', [col('a', 'int')]], ['row', [1]]],
      'SELECT 2 AS b\nSELECT * FROM nope\nSELECT 3 AS c': [
        ['recordset', [col('b', 'int')]],
        ['row', [2]],
        ['error', Object.assign(new Error("Invalid object name 'nope'."), { number: 208, lineNumber: 2, state: 1, class: 16 })],
        ['recordset', [col('c', 'int')]],
        ['row', [3]]
      ]
    });
    const script = 'SELECT 1 AS a\nGO\nSELECT 2 AS b\nSELECT * FROM nope\nSELECT 3 AS c';
    const err = (await driver.execute(script, { rowCap: 10 }).catch((e: unknown) => e)) as QueryFailure;
    expect(err).toBeInstanceOf(QueryFailure);
    expect(err.partial.map((r) => r.columns[0].name)).toEqual(['a', 'b', 'c']);
    expect(err.error).toMatchObject({ code: '208', statementIndex: 1, position: script.indexOf('SELECT * FROM nope'), detail: 'Msg 208, Level 16, State 1, Line 2' });
  });

  it('cancels the running request when the signal fires', async () => {
    const { driver, requests } = mssqlWith({ "WAITFOR DELAY '00:00:10'": [] });
    const controller = new AbortController();
    const running = driver.execute("WAITFOR DELAY '00:00:10'", { rowCap: 10, signal: controller.signal });
    await new Promise((r) => setImmediate(r));
    controller.abort();
    const err = (await running.catch((e: unknown) => e)) as QueryFailure;
    expect(requests[0].cancelled).toBe(1);
    expect(err.error.code).toBe('CANCELLED');
  });

  it('reports when the pool replaced the session connection between runs', async () => {
    const counter = { logins: 2, seen: 0 };
    const { driver } = mssqlWith({ 'SELECT 1 AS a': [['recordset', [col('a', 'int')]], ['row', [1]]] }, counter);
    const [first] = await driver.execute('SELECT 1 AS a', { rowCap: 10 });
    expect(first.messages).toBeUndefined();
    const [same] = await driver.execute('SELECT 1 AS a', { rowCap: 10 });
    expect(same.messages).toBeUndefined();
    counter.logins = 3;
    const [after] = await driver.execute('SELECT 1 AS a', { rowCap: 10 });
    expect(after.messages?.[0]).toMatch(/connection was lost and re-established/);
  });

  it('normalizes streamed rows', () => {
    expect(rowCells([1, 2])).toEqual([1, 2]);
    expect(rowCells({ 0: '[]' })).toEqual(['[]']);
  });
});
