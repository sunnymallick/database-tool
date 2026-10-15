/**
 * MySQL/MariaDB values -> tagged `Value`s. Every query installs a typeCast
 * that hands back the raw wire bytes (`field.buffer()`), so interpretation
 * happens here from the column definition: no JS Dates, BIGINT and DECIMAL
 * stay exact text, binary columns stay bytes.
 */
import type { Value } from '@shared/types';
import { bytesFromValue, bytesValue } from './common';

/** The column-definition fields we use (mysql2 ColumnDefinition / FieldPacket). */
export interface MysqlField {
  name: string;
  columnType: number;
  characterSet: number;
  flags: number;
  columnLength: number;
}

/** Protocol column types (mysql2 lib/constants/types.js). */
export const MYSQL_TYPES = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  NEWDATE: 0x0e,
  VARCHAR: 0x0f,
  BIT: 0x10,
  VECTOR: 0xf2,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  ENUM: 0xf7,
  SET: 0xf8,
  TINY_BLOB: 0xf9,
  MEDIUM_BLOB: 0xfa,
  LONG_BLOB: 0xfb,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
  GEOMETRY: 0xff
} as const;

const T = MYSQL_TYPES;
const BINARY_CHARSET = 63;
const UNSIGNED_FLAG = 32;
const ENUM_FLAG = 256;
const SET_FLAG = 2048;

const INT_NAMES: Record<number, string> = {
  [T.TINY]: 'TINYINT',
  [T.SHORT]: 'SMALLINT',
  [T.INT24]: 'MEDIUMINT',
  [T.LONG]: 'INT',
  [T.LONGLONG]: 'BIGINT'
};
const BLOB_TYPES = new Set<number>([T.TINY_BLOB, T.MEDIUM_BLOB, T.LONG_BLOB, T.BLOB]);
const DATETIME_TYPES = new Set<number>([T.DATE, T.NEWDATE, T.TIME, T.DATETIME, T.TIMESTAMP]);

const isBinary = (f: MysqlField) => f.characterSet === BINARY_CHARSET;
/** BOOLEAN is TINYINT(1); BIT(1) is the other common flag column. */
const isFlagColumn = (f: MysqlField) => (f.columnType === T.TINY || f.columnType === T.BIT) && f.columnLength === 1;

/** Readable type name for a result column, e.g. `BIGINT UNSIGNED`, `VARCHAR`, `BLOB`, `TINYINT(1)`. */
export function mysqlTypeName(f: MysqlField): string {
  const intName = INT_NAMES[f.columnType];
  if (intName) {
    const base = f.columnType === T.TINY && f.columnLength === 1 ? 'TINYINT(1)' : intName;
    return f.flags & UNSIGNED_FLAG ? `${base} UNSIGNED` : base;
  }
  switch (f.columnType) {
    case T.DECIMAL:
    case T.NEWDECIMAL:
      return 'DECIMAL';
    case T.FLOAT:
      return 'FLOAT';
    case T.DOUBLE:
      return 'DOUBLE';
    case T.NULL:
      return 'NULL';
    case T.DATE:
    case T.NEWDATE:
      return 'DATE';
    case T.TIME:
      return 'TIME';
    case T.DATETIME:
      return 'DATETIME';
    case T.TIMESTAMP:
      return 'TIMESTAMP';
    case T.YEAR:
      return 'YEAR';
    case T.BIT:
      return f.columnLength === 1 ? 'BIT(1)' : 'BIT';
    case T.JSON:
      return 'JSON';
    case T.ENUM:
      return 'ENUM';
    case T.SET:
      return 'SET';
    case T.GEOMETRY:
      return 'GEOMETRY';
    case T.VECTOR:
      return 'VECTOR';
    case T.VARCHAR:
    case T.VAR_STRING:
      return isBinary(f) ? 'VARBINARY' : 'VARCHAR';
    case T.STRING:
      if (f.flags & ENUM_FLAG) return 'ENUM';
      if (f.flags & SET_FLAG) return 'SET';
      return isBinary(f) ? 'BINARY' : 'CHAR';
    default:
      if (BLOB_TYPES.has(f.columnType)) return isBinary(f) ? 'BLOB' : 'TEXT';
      return `TYPE_${f.columnType}`;
  }
}

/** BIT(n) bytes are big-endian. */
function bitToInt(raw: Buffer): string {
  let n = 0n;
  for (const b of raw) n = (n << 8n) | BigInt(b);
  return n.toString();
}

export function mysqlValue(f: MysqlField, raw: Buffer | null): Value {
  if (raw === null) return { t: 'null' };
  const type = f.columnType;
  if (INT_NAMES[type] || type === T.YEAR) {
    const text = raw.toString('latin1');
    if (isFlagColumn(f) && (text === '0' || text === '1')) return { t: 'bool', v: text === '1' };
    return { t: 'int', v: text };
  }
  if (type === T.BIT) return isFlagColumn(f) ? { t: 'bool', v: raw.some((b) => b !== 0) } : { t: 'int', v: bitToInt(raw) };
  if (type === T.DECIMAL || type === T.NEWDECIMAL) return { t: 'decimal', v: raw.toString('latin1') };
  if (type === T.FLOAT || type === T.DOUBLE) return { t: 'float', v: Number(raw.toString('latin1')) };
  if (DATETIME_TYPES.has(type)) return { t: 'datetime', v: raw.toString('latin1') };
  if (type === T.JSON) {
    const text = raw.toString('utf8');
    try {
      return { t: 'json', v: JSON.parse(text) };
    } catch {
      return { t: 'text', v: text };
    }
  }
  if (type === T.GEOMETRY || type === T.VECTOR) return bytesValue(raw);
  if (isBinary(f) && (BLOB_TYPES.has(type) || type === T.VARCHAR || type === T.VAR_STRING || type === T.STRING)) return bytesValue(raw);
  return { t: 'text', v: raw.toString('utf8') };
}

/** A `Value` as a mysql2 prepared-statement parameter. */
export function mysqlParam(v: Value): unknown {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v;
    case 'float':
      return v.v;
    case 'int': {
      // A string would be stored as raw bytes in a BIT column ('7' -> 0x37); numbers bind as integers.
      const n = Number(v.v);
      return /^-?\d+$/.test(v.v) && Number.isSafeInteger(n) ? n : v.v;
    }
    case 'decimal':
    case 'text':
    case 'datetime':
      return v.v;
    case 'json':
      return JSON.stringify(v.v);
    case 'bytes':
      return bytesFromValue(v);
  }
}

/**
 * Best-effort error offset for MySQL syntax errors, which say
 * `... near 'rest of statement' at line N`. Returns an offset within the
 * statement text, or undefined.
 */
export function mysqlErrorOffset(statement: string, message: string): number | undefined {
  const m = /near '([\s\S]*)' at line (\d+)\s*$/.exec(message);
  if (!m) return undefined;
  const line = Number(m[2]);
  let lineStart = 0;
  for (let l = 1; l < line; l++) {
    const nl = statement.indexOf('\n', lineStart);
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  const fragment = m[1].slice(0, 40);
  if (!fragment) return statement.length;
  const at = statement.indexOf(fragment, lineStart);
  return at === -1 ? lineStart : at;
}
