import { describe, expect, it } from 'vitest';
import { mssqlConfig, mssqlQueryError } from '../../src/main/db/mssql';
import { mssqlCreateTableDdl } from '../../src/main/db/mssql-ddl';
import { mysqlConnectionOptions, mysqlQueryError } from '../../src/main/db/mysql';
import { pgClientConfig, pgQueryError, returnsRows } from '../../src/main/db/postgres';
import { columnsCoverKey, effectiveRowCap } from '../../src/main/db/query-runner';
import { sqliteQueryError } from '../../src/main/db/sqlite';
import { profile } from '../integration/support';

describe('SQL Server config', () => {
  const base = profile('mssql', { host: 'sql.example.com', port: 1433, username: 'app', database: 'Orders', ssl: true, trustServerCertificate: true });

  it('maps the profile onto mssql/tedious options', () => {
    const cfg = mssqlConfig(base, 'pw', 'Orders', { connectTimeoutMs: 9000 }, 'session');
    expect(cfg).toMatchObject({
      server: 'sql.example.com',
      port: 1433,
      database: 'Orders',
      user: 'app',
      password: 'pw',
      connectionTimeout: 9000,
      requestTimeout: 0,
      validateConnection: 'socket',
      pool: { min: 0, max: 1 },
      options: { encrypt: true, trustServerCertificate: true, appName: 'database-tool', useUTC: true }
    });
    expect(cfg.domain).toBeUndefined();
    const browse = mssqlConfig(base, 'pw', 'Orders', {}, 'browse');
    expect(browse.requestTimeout).toBe(60_000);
    expect(browse.pool).toMatchObject({ max: 3 });
  });

  it('uses instanceName (no port), domain (NTLM), and applicationName from options', () => {
    const named = profile('mssql', { host: 'sqlhost', port: 1433, options: { instanceName: 'SQLEXPRESS', domain: 'CORP', applicationName: 'Reports' } });
    const cfg = mssqlConfig(named, null, '', {}, 'session');
    expect(cfg.port).toBeUndefined();
    expect(cfg.options?.instanceName).toBe('SQLEXPRESS');
    expect(cfg.domain).toBe('CORP');
    expect(cfg.options?.appName).toBe('Reports');
    expect(cfg.password).toBeUndefined();
    expect(cfg.database).toBeUndefined();
    expect(mssqlConfig({ ...base, ssl: false, trustServerCertificate: false }, null, 'x', {}, 'session').options).toMatchObject({ encrypt: false, trustServerCertificate: false });
  });

  it('maps errors to batch offsets and SSMS-style details', () => {
    const batch = { text: 'SELECT 1\nSELECT * FROM nope', start: 10, end: 37, repeat: 1 };
    const err = Object.assign(new Error("Invalid object name 'nope'."), { number: 208, lineNumber: 2, state: 1, class: 16, procName: '' });
    expect(mssqlQueryError(err, batch, 1)).toEqual({
      message: "Invalid object name 'nope'.",
      code: '208',
      statementIndex: 1,
      position: 19,
      detail: 'Msg 208, Level 16, State 1, Line 2'
    });
    const inProc = mssqlQueryError(Object.assign(new Error('x'), { number: 50000, lineNumber: 7, procName: 'dbo.p' }), batch, 0, [new Error('second')]);
    expect(inProc.position).toBeUndefined();
    expect(inProc.detail).toBe('Msg 50000, Level ?, State ?, Procedure dbo.p, Line 7\nsecond');
    // Client-side errors carry mssql's string code in `number`; no SSMS-style header for them.
    const socket = mssqlQueryError(Object.assign(new Error('Connection lost'), { number: 'ESOCKET', code: 'ESOCKET' }), batch, 0);
    expect(socket).toEqual({ message: 'Connection lost', code: 'ESOCKET', statementIndex: 0 });
  });
});

describe('SQL Server CREATE TABLE synthesis', () => {
  it('scripts columns, constraints, indexes, and comments', () => {
    const ddl = mssqlCreateTableDdl({
      schema: 'dbo',
      name: 'Orders',
      comment: "Customer's orders",
      columns: [
        { name: 'Id', type: 'int', nullable: false, identity: { seed: '1', increment: '1' } },
        { name: 'CustomerId', type: 'int', nullable: false },
        { name: 'Status', type: 'nvarchar(20)', nullable: false, defaultConstraint: { name: 'DF_Orders_Status', definition: "(N'new')" } },
        { name: 'Total', type: 'decimal(12, 2)', nullable: true, comment: 'Gross' },
        { name: 'TotalWithTax', type: 'decimal(12, 2)', nullable: true, computed: { definition: '([Total]*(1.2))', persisted: true } }
      ],
      indexes: [
        { name: 'PK_Orders', typeDesc: 'CLUSTERED', unique: true, primary: true, uniqueConstraint: false, columns: [{ name: 'Id', desc: false }], included: [], filter: null },
        { name: 'UQ_Orders_Status', typeDesc: 'NONCLUSTERED', unique: true, primary: false, uniqueConstraint: true, columns: [{ name: 'Status', desc: false }], included: [], filter: null },
        { name: 'IX_Orders_Customer', typeDesc: 'NONCLUSTERED', unique: false, primary: false, uniqueConstraint: false, columns: [{ name: 'CustomerId', desc: true }], included: ['Total'], filter: '([Total]>(0))' },
        { name: 'CCI', typeDesc: 'NONCLUSTERED COLUMNSTORE', unique: false, primary: false, uniqueConstraint: false, columns: [], included: [], filter: null }
      ],
      foreignKeys: [{ name: 'FK_Orders_Customers', columns: ['CustomerId'], refSchema: 'dbo', refTable: 'Customers', refColumns: ['Id'], onDelete: 'CASCADE', onUpdate: 'NO_ACTION' }],
      checks: [{ name: 'CK_Orders_Total', definition: '([Total]>=(0))' }]
    });
    expect(ddl).toBe(
      [
        'CREATE TABLE [dbo].[Orders] (',
        '    [Id] int IDENTITY(1,1) NOT NULL,',
        '    [CustomerId] int NOT NULL,',
        "    [Status] nvarchar(20) NOT NULL CONSTRAINT [DF_Orders_Status] DEFAULT (N'new'),",
        '    [Total] decimal(12, 2) NULL,',
        '    [TotalWithTax] AS ([Total]*(1.2)) PERSISTED,',
        '    CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([Id] ASC),',
        '    CONSTRAINT [UQ_Orders_Status] UNIQUE NONCLUSTERED ([Status] ASC),',
        '    CONSTRAINT [FK_Orders_Customers] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customers] ([Id]) ON DELETE CASCADE,',
        '    CONSTRAINT [CK_Orders_Total] CHECK ([Total]>=(0))',
        ');',
        '',
        'CREATE NONCLUSTERED INDEX [IX_Orders_Customer] ON [dbo].[Orders] ([CustomerId] DESC) INCLUDE ([Total]) WHERE ([Total]>(0));',
        '',
        '-- NONCLUSTERED COLUMNSTORE index [CCI] is not scripted.',
        '',
        "EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Customer''s orders', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Orders';",
        "EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'Gross', @level0type = N'SCHEMA', @level0name = N'dbo', @level1type = N'TABLE', @level1name = N'Orders', @level2type = N'COLUMN', @level2name = N'Total';",
        ''
      ].join('\n')
    );
  });
});

describe('Postgres and MySQL config', () => {
  it('builds node-postgres options', () => {
    const cfg = pgClientConfig(profile('postgres', { host: 'db', port: 6543, username: 'me', ssl: true, trustServerCertificate: true }), 'pw', 'app', { readOnly: true, connectTimeoutMs: 5000 });
    expect(cfg).toMatchObject({ host: 'db', port: 6543, user: 'me', password: 'pw', database: 'app', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
    expect(cfg.options).toBe('-c default_transaction_read_only=on');
    expect(pgClientConfig(profile('postgres'), null, '', {})).toMatchObject({ ssl: false, user: undefined, password: undefined, database: undefined, port: 5432 });
  });

  it('builds mysql2 options that keep values raw and refuse LOCAL INFILE', () => {
    const opts = mysqlConnectionOptions(profile('mysql', { host: 'my', port: 3307, username: 'u', ssl: true }), 'pw', 'app', {});
    expect(opts).toMatchObject({ host: 'my', port: 3307, user: 'u', database: 'app', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, ssl: { rejectUnauthorized: true } });
    expect(opts.flags).toEqual(['-LOCAL_FILES']);
  });

  it('decides which Postgres statements go through a capped portal', () => {
    expect(returnsRows('select 1')).toBe(true);
    expect(returnsRows('-- c\n(VALUES (1))')).toBe(true);
    expect(returnsRows('UPDATE t SET a = 1 RETURNING *')).toBe(true);
    expect(returnsRows("UPDATE t SET a = 'returning'")).toBe(false);
    expect(returnsRows('VACUUM t')).toBe(false);
    expect(returnsRows('CALL p()')).toBe(false);
  });

  it('maps engine errors with positions into the script', () => {
    const stmt = { text: 'SELECT nope FROM t', start: 20, end: 38 };
    expect(pgQueryError(Object.assign(new Error('column "nope" does not exist'), { code: '42703', position: '8', hint: 'Perhaps you meant "note".' }), stmt, 2)).toEqual({
      message: 'column "nope" does not exist',
      code: '42703',
      statementIndex: 2,
      position: 27,
      hint: 'Perhaps you meant "note".'
    });
    const my = mysqlQueryError(Object.assign(new Error('x'), { errno: 1064, sqlState: '42000', code: 'ER_PARSE_ERROR', sqlMessage: "You have an error in your SQL syntax; ... near 'FROM t' at line 1" }), stmt, 0);
    expect(my).toMatchObject({ code: '1064', position: 32, detail: 'SQLSTATE 42000 (ER_PARSE_ERROR)' });
    const lite = sqliteQueryError(Object.assign(new Error('near "nope": syntax error'), { errcode: 1, errstr: 'SQL logic error' }), stmt, 0);
    expect(lite).toMatchObject({ code: '1', position: 27, detail: 'SQL logic error' });
  });
});

describe('query runner helpers', () => {
  it('picks the row cap: request (0 = unlimited) over settings, and matches key columns', () => {
    expect(effectiveRowCap(undefined, 5000)).toBe(5000);
    expect(effectiveRowCap(0, 5000)).toBe(0);
    expect(effectiveRowCap(25.7, 5000)).toBe(25);
    expect(effectiveRowCap(-1, 5000)).toBe(5000);
    expect(effectiveRowCap(Number.POSITIVE_INFINITY, 5000)).toBe(5000);
    expect(effectiveRowCap(1e12, 5000)).toBe(10_000_000);

    expect(columnsCoverKey('postgres', ['id', 'name'], ['id'])).toBe(true);
    expect(columnsCoverKey('postgres', ['ID'], ['id'])).toBe(false);
    expect(columnsCoverKey('mssql', ['ID', 'Name'], ['Id'])).toBe(true);
    expect(columnsCoverKey('mysql', ['a'], ['a', 'b'])).toBe(false);
    expect(columnsCoverKey('sqlite', ['a'], [])).toBe(false);
  });
});
