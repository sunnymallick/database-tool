import { describe, expect, it } from 'vitest';
import { BYTES_PREVIEW_LIMIT, Mutex, bytesValue, codePointsToIndex, hexValue, lineToOffset, withTimeout } from '../../src/main/db/common';
import { parsePgArray, pgByteaValue, pgMapper, pgParam, pgTypeName, type PgTypeInfo } from '../../src/main/db/postgres-values';
import { MYSQL_TYPES as T, mysqlErrorOffset, mysqlParam, mysqlTypeName, mysqlValue, type MysqlField } from '../../src/main/db/mysql-values';
import { decimalText, formatMssqlDate, mssqlParam, mssqlTypeName, mssqlValue, renderMssqlType } from '../../src/main/db/mssql-values';
import { sqliteErrorOffset, sqliteParam, sqliteStorageClass, sqliteValue } from '../../src/main/db/sqlite-values';
import { classifyType } from '@shared/values';
import { mssqlDateTimeText, sqlLiteral } from '@shared/sql';

describe('common helpers', () => {
  it('caps binary previews at 64KB but keeps the full length', () => {
    expect(bytesValue(Buffer.from([0, 255]))).toEqual({ t: 'bytes', hex: '00ff', length: 2 });
    const big = bytesValue(Buffer.alloc(BYTES_PREVIEW_LIMIT + 10, 1));
    expect(big).toMatchObject({ t: 'bytes', length: BYTES_PREVIEW_LIMIT + 10, truncated: true });
    expect((big as { hex: string }).hex).toHaveLength(BYTES_PREVIEW_LIMIT * 2);
    expect(hexValue('ABCD')).toEqual({ t: 'bytes', hex: 'abcd', length: 2 });
    expect(hexValue('00'.repeat(BYTES_PREVIEW_LIMIT + 1))).toMatchObject({ truncated: true, length: BYTES_PREVIEW_LIMIT + 1 });
  });

  it('maps code points to UTF-16 indexes and lines to offsets', () => {
    expect(codePointsToIndex('a😀b', 2)).toBe(3);
    expect(codePointsToIndex('abc', 10)).toBe(3);
    expect(lineToOffset('a\nbb\nccc', 3)).toBe(5);
    expect(lineToOffset('a', 5)).toBe(0);
  });

  it('serializes work with Mutex, even after failures', async () => {
    const m = new Mutex();
    const order: number[] = [];
    const slow = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      throw new Error('boom');
    });
    const fast = m.run(async () => order.push(2));
    await expect(slow).rejects.toThrow('boom');
    await fast;
    expect(order).toEqual([1, 2]);
  });

  it('withTimeout rejects late and hands the late value to onLate', async () => {
    let late: string | null = null;
    const p = new Promise<string>((r) => setTimeout(() => r('done'), 30));
    await expect(withTimeout(p, 5, 'too slow', (v) => (late = v))).rejects.toThrow('too slow');
    await new Promise((r) => setTimeout(r, 40));
    expect(late).toBe('done');
  });
});

describe('postgres values', () => {
  const t = (name: string, category = 'U', extra: Partial<PgTypeInfo> = {}): PgTypeInfo => ({ oid: 1, name, category, ...extra });

  it('maps scalars by type', () => {
    expect(pgMapper(t('bool'))('t')).toEqual({ t: 'bool', v: true });
    expect(pgMapper(t('int8'))('-9223372036854775808')).toEqual({ t: 'int', v: '-9223372036854775808' });
    expect(pgMapper(t('float8'))('Infinity')).toEqual({ t: 'float', v: Infinity });
    expect(pgMapper(t('numeric'))('12.50')).toEqual({ t: 'decimal', v: '12.50' });
    expect(pgMapper(t('money'))('$1,234.50')).toEqual({ t: 'decimal', v: '$1,234.50' });
    expect(pgMapper(t('jsonb'))('{"a":1}')).toEqual({ t: 'json', v: { a: 1 } });
    expect(pgMapper(t('timestamptz'))('2025-01-01 00:00:00+00')).toEqual({ t: 'datetime', v: '2025-01-01 00:00:00+00' });
    expect(pgMapper(t('interval'))('1 day')).toEqual({ t: 'datetime', v: '1 day' });
    expect(pgMapper(t('uuid'))('x')).toEqual({ t: 'text', v: 'x' });
    expect(pgMapper(undefined)('?')).toEqual({ t: 'text', v: '?' });
    expect(pgMapper(t('int4'))(null)).toEqual({ t: 'null' });
  });

  it('follows domains to their base type', () => {
    expect(pgMapper(t('positive_int', 'N', { base: t('int4', 'N') }))('5')).toEqual({ t: 'int', v: '5' });
  });

  it('parses arrays into JSON with typed elements', () => {
    const intArr = t('_int4', 'A', { elem: t('int4', 'N') });
    expect(pgMapper(intArr)('{1,2,NULL}')).toEqual({ t: 'json', v: [1, 2, null] });
    expect(pgMapper(t('_int8', 'A', { elem: t('int8', 'N') }))('{9223372036854775807}')).toEqual({ t: 'json', v: ['9223372036854775807'] });
    expect(pgMapper(t('_bool', 'A', { elem: t('bool', 'B') }))('{t,f}')).toEqual({ t: 'json', v: [true, false] });
    expect(pgMapper(t('_jsonb', 'A', { elem: t('jsonb') }))('{"{\\"a\\": 1}"}')).toEqual({ t: 'json', v: [{ a: 1 }] });
    expect(parsePgArray('{{"a,b","c\\"d"},{NULL,"NULL"}}')).toEqual([['a,b', 'c"d'], [null, 'NULL']]);
    expect(parsePgArray('[0:1]={x,y}')).toEqual(['x', 'y']);
    expect(parsePgArray('{}')).toEqual([]);
    expect(pgTypeName(intArr, 1007)).toBe('int4[]');
    expect(pgTypeName(undefined, 99999)).toBe('oid:99999');
    expect(classifyType('int4[]')).toBe('json');
  });

  it('decodes bytea in hex and escape formats', () => {
    expect(pgByteaValue('\\x00ff')).toEqual({ t: 'bytes', hex: '00ff', length: 2 });
    expect(pgByteaValue('a\\000\\\\')).toEqual({ t: 'bytes', hex: '61005c', length: 3 });
  });

  it('binds values as node-postgres parameters', () => {
    expect(pgParam({ t: 'int', v: '9007199254740993' })).toBe('9007199254740993');
    expect(pgParam({ t: 'json', v: [1, 2] })).toBe('[1,2]');
    expect(pgParam({ t: 'bytes', hex: '00ff', length: 2 })).toEqual(Buffer.from([0, 255]));
    expect(pgParam({ t: 'float', v: Number.NaN })).toBe('NaN');
    expect(() => pgParam({ t: 'bytes', hex: '00', length: 9, truncated: true })).toThrow(/truncated/);
  });
});

describe('mysql values', () => {
  const f = (columnType: number, extra: Partial<MysqlField> = {}): MysqlField => ({ name: 'c', columnType, characterSet: 45, flags: 0, columnLength: 11, ...extra });
  const b = (s: string) => Buffer.from(s);

  it('keeps integers and decimals exact', () => {
    expect(mysqlValue(f(T.LONGLONG, { flags: 32 }), b('18446744073709551615'))).toEqual({ t: 'int', v: '18446744073709551615' });
    expect(mysqlValue(f(T.NEWDECIMAL), b('12345678901234567890.12'))).toEqual({ t: 'decimal', v: '12345678901234567890.12' });
    expect(mysqlValue(f(T.DOUBLE), b('1.5'))).toEqual({ t: 'float', v: 1.5 });
    expect(mysqlValue(f(T.YEAR), b('2024'))).toEqual({ t: 'int', v: '2024' });
  });

  it('treats TINYINT(1) and BIT(1) as booleans', () => {
    expect(mysqlValue(f(T.TINY, { columnLength: 1 }), b('1'))).toEqual({ t: 'bool', v: true });
    expect(mysqlValue(f(T.TINY, { columnLength: 1 }), b('7'))).toEqual({ t: 'int', v: '7' });
    expect(mysqlValue(f(T.TINY, { columnLength: 4 }), b('1'))).toEqual({ t: 'int', v: '1' });
    expect(mysqlValue(f(T.BIT, { columnLength: 1, characterSet: 63 }), Buffer.from([1]))).toEqual({ t: 'bool', v: true });
    expect(mysqlValue(f(T.BIT, { columnLength: 16, characterSet: 63 }), Buffer.from([1, 2]))).toEqual({ t: 'int', v: '258' });
  });

  it('returns temporal values as text, JSON parsed, binary as bytes', () => {
    expect(mysqlValue(f(T.DATETIME), b('2025-01-02 03:04:05.123'))).toEqual({ t: 'datetime', v: '2025-01-02 03:04:05.123' });
    expect(mysqlValue(f(T.DATE), b('0000-00-00'))).toEqual({ t: 'datetime', v: '0000-00-00' });
    expect(mysqlValue(f(T.TIME), b('-838:59:59'))).toEqual({ t: 'datetime', v: '-838:59:59' });
    expect(mysqlValue(f(T.JSON, { characterSet: 63 }), b('{"a": [1]}'))).toEqual({ t: 'json', v: { a: [1] } });
    expect(mysqlValue(f(T.BLOB, { characterSet: 63 }), Buffer.from([1, 2]))).toEqual({ t: 'bytes', hex: '0102', length: 2 });
    expect(mysqlValue(f(T.BLOB, { characterSet: 255 }), b('héllo'))).toEqual({ t: 'text', v: 'héllo' });
    expect(mysqlValue(f(T.VAR_STRING, { characterSet: 63 }), Buffer.from([255]))).toEqual({ t: 'bytes', hex: 'ff', length: 1 });
    expect(mysqlValue(f(T.GEOMETRY, { characterSet: 63 }), Buffer.from([0, 0]))).toMatchObject({ t: 'bytes' });
    expect(mysqlValue(f(T.VARCHAR), null)).toEqual({ t: 'null' });
  });

  it('names types', () => {
    expect(mysqlTypeName(f(T.LONGLONG, { flags: 32 }))).toBe('BIGINT UNSIGNED');
    expect(mysqlTypeName(f(T.TINY, { columnLength: 1 }))).toBe('TINYINT(1)');
    expect(mysqlTypeName(f(T.BLOB, { characterSet: 63 }))).toBe('BLOB');
    expect(mysqlTypeName(f(T.BLOB))).toBe('TEXT');
    expect(mysqlTypeName(f(T.VAR_STRING))).toBe('VARCHAR');
    expect(mysqlTypeName(f(T.STRING, { flags: 256 }))).toBe('ENUM');
    expect(mysqlTypeName(f(T.NEWDECIMAL))).toBe('DECIMAL');
  });

  it('binds parameters and locates syntax errors', () => {
    expect(mysqlParam({ t: 'json', v: { a: 1 } })).toBe('{"a":1}');
    expect(mysqlParam({ t: 'bool', v: false })).toBe(false);
    // Integers bind as numbers so BIT(n) columns get the value, not its ASCII bytes.
    expect(mysqlParam({ t: 'int', v: '7' })).toBe(7);
    expect(mysqlParam({ t: 'int', v: '18446744073709551615' })).toBe('18446744073709551615');
    expect(mysqlParam({ t: 'bytes', hex: 'ff', length: 1 })).toEqual(Buffer.from([255]));
    const stmt = 'SELECT 1\nFROM t\nWHER x = 1';
    const msg = "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'WHER x = 1' at line 3";
    expect(mysqlErrorOffset(stmt, msg)).toBe(stmt.indexOf('WHER'));
    expect(mysqlErrorOffset('SELECT (', "... near '' at line 1")).toBe('SELECT ('.length);
    expect(mysqlErrorOffset(stmt, 'Unknown column')).toBeUndefined();
  });
});

describe('mssql values', () => {
  const col = (declaration: string, scale?: number, name = 'c') => ({ name, declaration, ...(scale !== undefined ? { scale } : {}) });
  const tedDate = (iso: string, nanosecondsDelta = 0) => Object.defineProperty(new Date(iso), 'nanosecondsDelta', { value: nanosecondsDelta });

  it('maps numbers, bits, and GUIDs', () => {
    expect(mssqlValue(col('bit'), true)).toEqual({ t: 'bool', v: true });
    expect(mssqlValue(col('int'), 42)).toEqual({ t: 'int', v: '42' });
    expect(mssqlValue(col('bigint'), '9223372036854775807')).toEqual({ t: 'int', v: '9223372036854775807' });
    expect(mssqlValue(col('decimal', 2), 12.5)).toEqual({ t: 'decimal', v: '12.50' });
    expect(mssqlValue(col('money', 4), 3.1)).toEqual({ t: 'decimal', v: '3.1000' });
    expect(mssqlValue(col('float'), 0.25)).toEqual({ t: 'float', v: 0.25 });
    expect(mssqlValue(col('uniqueidentifier'), 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')).toEqual({ t: 'text', v: 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11' });
    expect(mssqlValue(col('nvarchar'), null)).toEqual({ t: 'null' });
  });

  it('renders temporal types from UTC parts with full precision', () => {
    expect(mssqlValue(col('date'), tedDate('2025-03-04T00:00:00Z'))).toEqual({ t: 'datetime', v: '2025-03-04' });
    expect(mssqlValue(col('datetime'), tedDate('2025-03-04T05:06:07.123Z'))).toEqual({ t: 'datetime', v: '2025-03-04 05:06:07.123' });
    expect(mssqlValue(col('smalldatetime'), tedDate('2025-03-04T05:06:00Z'))).toEqual({ t: 'datetime', v: '2025-03-04 05:06:00' });
    expect(mssqlValue(col('datetime2', 7), tedDate('2025-03-04T05:06:07.123Z', 0.0004567))).toEqual({ t: 'datetime', v: '2025-03-04 05:06:07.1234567' });
    expect(mssqlValue(col('datetime2', 0), tedDate('2025-03-04T05:06:07.999Z'))).toEqual({ t: 'datetime', v: '2025-03-04 05:06:07' });
    expect(mssqlValue(col('time', 3), tedDate('1970-01-01T13:14:15.5Z'))).toEqual({ t: 'datetime', v: '13:14:15.500' });
    expect(mssqlValue(col('datetimeoffset', 3), tedDate('2025-03-04T05:06:07.000Z'))).toEqual({ t: 'datetime', v: '2025-03-04 05:06:07.000 +00:00' });
    expect(formatMssqlDate(new Date('0001-01-01T00:00:00Z'), 'date')).toBe('0001-01-01');
  });

  it('maps binary, FOR JSON, UDTs, and sql_variant', () => {
    expect(mssqlValue(col('varbinary'), Buffer.from([1]))).toEqual({ t: 'bytes', hex: '01', length: 1 });
    expect(mssqlValue(col('nvarchar', undefined, 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B'), '[{"a":1}]')).toEqual({ t: 'json', v: [{ a: 1 }] });
    expect(mssqlValue({ name: 'g', declaration: 'udt', udtName: 'geography' }, { srid: 4326, points: [] })).toEqual({ t: 'json', v: { srid: 4326, points: [] } });
    expect(mssqlValue(col('variant'), 3)).toEqual({ t: 'int', v: '3' });
    expect(mssqlValue(col('variant'), 'x')).toEqual({ t: 'text', v: 'x' });
    expect(mssqlTypeName(col('variant'))).toBe('sql_variant');
    expect(mssqlTypeName({ name: 'g', declaration: 'udt', udtName: 'geography' })).toBe('geography');
  });

  it('renders decimals from the shortest exact form, padded to scale (no binary noise)', () => {
    expect(decimalText(-122.419415, 15)).toBe('-122.419415000000000');
    expect(decimalText(0.1, 18)).toBe('0.100000000000000000');
    expect(decimalText(1234567.1, 10)).toBe('1234567.1000000000');
    expect(decimalText(5, 0)).toBe('5');
    expect(decimalText(1e-7, 8)).toBe('0.00000010');
    expect(decimalText(2e21, 2)).toBe('2e+21');
  });

  it('sends date/times in a form every SET DATEFORMAT reads the same way', () => {
    expect(mssqlDateTimeText('2024-01-05')).toBe('20240105');
    expect(mssqlDateTimeText('2024-01-05 10:11:12.123')).toBe('2024-01-05T10:11:12.123');
    expect(mssqlDateTimeText('2024-01-05 10:11:12.1234567 +00:00')).toBe('2024-01-05T10:11:12.1234567+00:00');
    expect(mssqlDateTimeText('10:11:12')).toBe('10:11:12');
    expect(mssqlDateTimeText('Jan 5 2024')).toBe('Jan 5 2024');
    expect(mssqlParam({ t: 'datetime', v: '2024-01-05 10:11:12.123' })).toEqual({ type: 'nvarchar', value: '2024-01-05T10:11:12.123' });
    expect(sqlLiteral('mssql', { t: 'datetime', v: '2024-01-05' })).toBe("N'20240105'");
    expect(sqlLiteral('postgres', { t: 'datetime', v: '2024-01-05' })).toBe("'2024-01-05'");
  });

  it('binds parameters so the server converts exactly', () => {
    expect(mssqlParam({ t: 'int', v: '9223372036854775807' })).toEqual({ type: 'nvarchar', value: '9223372036854775807' });
    expect(mssqlParam({ t: 'decimal', v: '1.10' })).toEqual({ type: 'nvarchar', value: '1.10' });
    expect(mssqlParam({ t: 'bool', v: true })).toEqual({ type: 'bit', value: true });
    expect(mssqlParam({ t: 'float', v: 1.5 })).toEqual({ type: 'float', value: 1.5 });
    expect(mssqlParam({ t: 'bytes', hex: '0a', length: 1 })).toEqual({ type: 'varbinary', value: Buffer.from([10]) });
    expect(mssqlParam({ t: 'json', v: { a: 1 } })).toEqual({ type: 'nvarchar', value: '{"a":1}' });
  });

  it('renders sys.types definitions', () => {
    expect(renderMssqlType('nvarchar', 200, 0, 0)).toBe('nvarchar(100)');
    expect(renderMssqlType('varchar', -1, 0, 0)).toBe('varchar(max)');
    expect(renderMssqlType('decimal', 9, 10, 2)).toBe('decimal(10, 2)');
    expect(renderMssqlType('datetime2', 8, 27, 7)).toBe('datetime2(7)');
    expect(renderMssqlType('int', 4, 10, 0)).toBe('int');
  });
});

describe('sqlite values', () => {
  it('refines storage values with the declared type', () => {
    expect(sqliteValue(9223372036854775807n, 'INTEGER')).toEqual({ t: 'int', v: '9223372036854775807' });
    expect(sqliteValue(1n, 'BOOLEAN')).toEqual({ t: 'bool', v: true });
    expect(sqliteValue(2n, 'BOOLEAN')).toEqual({ t: 'int', v: '2' });
    expect(sqliteValue(12.5, 'NUMERIC(10,2)')).toEqual({ t: 'decimal', v: '12.5' });
    expect(sqliteValue(3n, 'NUMERIC')).toEqual({ t: 'decimal', v: '3' });
    expect(sqliteValue('{"a":1}', 'JSON')).toEqual({ t: 'json', v: { a: 1 } });
    expect(sqliteValue('not json', 'JSON')).toEqual({ t: 'text', v: 'not json' });
    expect(sqliteValue('2025-01-01', 'DATE')).toEqual({ t: 'datetime', v: '2025-01-01' });
    expect(sqliteValue(1.5, null)).toEqual({ t: 'float', v: 1.5 });
    expect(sqliteValue(new Uint8Array([1, 2]), 'BLOB')).toEqual({ t: 'bytes', hex: '0102', length: 2 });
    expect(sqliteValue(null, 'TEXT')).toEqual({ t: 'null' });
  });

  it('binds parameters and names storage classes', () => {
    expect(sqliteParam({ t: 'int', v: '9223372036854775807' })).toBe(9223372036854775807n);
    expect(sqliteParam({ t: 'bool', v: true })).toBe(1);
    expect(sqliteParam({ t: 'decimal', v: '1.10' })).toBe('1.10');
    expect(sqliteStorageClass(1n)).toBe('INTEGER');
    expect(sqliteStorageClass('x')).toBe('TEXT');
    expect(sqliteStorageClass(new Uint8Array())).toBe('BLOB');
    expect(sqliteErrorOffset('SELEC 1', 'near "SELEC": syntax error')).toBe(0);
    expect(sqliteErrorOffset('SELECT 1', 'no such table: x')).toBeUndefined();
  });
});
