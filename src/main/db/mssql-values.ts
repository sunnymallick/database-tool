/**
 * SQL Server (tedious via mssql) values -> tagged `Value`s.
 *
 * tedious hands back JS Dates for temporal types (built from UTC parts when
 * `useUTC` is on, which we keep), strings for BIGINT and UNIQUEIDENTIFIER,
 * numbers for DECIMAL/MONEY, Buffers for binary, booleans for BIT. Dates are
 * rendered back to server-style text with the UTC getters plus tedious'
 * `nanosecondsDelta`, so DATETIME2(7) keeps all seven fractional digits.
 */
import { mssqlDateTimeText } from '@shared/sql';
import type { Value } from '@shared/types';
import { bytesFromValue, bytesValue } from './common';

/** Column facts the mapper needs (from mssql's recordset metadata). */
export interface MssqlColumn {
  name: string;
  /** mssql type declaration, lower case: `int`, `nvarchar`, `datetime2`, `variant`, `udt`, ... */
  declaration: string;
  scale?: number;
  /** UDT type name (`geography`, `geometry`, `hierarchyid`). */
  udtName?: string;
}

/** FOR JSON results arrive as one column with this generated name. */
const FOR_JSON_COLUMN = 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B';

const INT_TYPES = new Set(['tinyint', 'smallint', 'int', 'bigint']);
const DECIMAL_TYPES = new Set(['decimal', 'numeric', 'money', 'smallmoney']);
const FLOAT_TYPES = new Set(['float', 'real']);
const BINARY_TYPES = new Set(['binary', 'varbinary', 'image']);

export function mssqlTypeName(c: MssqlColumn): string {
  if (c.declaration === 'variant') return 'sql_variant';
  if (c.declaration === 'udt') return c.udtName ?? 'udt';
  return c.declaration || 'unknown';
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function datePart(d: Date): string {
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `HH:MM:SS` plus `scale` fractional digits (100ns ticks come from ms + tedious' nanosecondsDelta). */
function timePart(d: Date, scale: number): string {
  const base = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (scale <= 0) return base;
  const delta = (d as Date & { nanosecondsDelta?: number }).nanosecondsDelta ?? 0;
  const ticks = d.getUTCMilliseconds() * 10_000 + Math.round(delta * 1e7);
  return `${base}.${pad(Math.min(ticks, 9_999_999), 7).slice(0, Math.min(scale, 7))}`;
}

/** Render a tedious Date the way SQL Server prints the column type. */
export function formatMssqlDate(d: Date, declaration: string, scale?: number): string {
  const s = scale ?? 7;
  switch (declaration) {
    case 'date':
      return datePart(d);
    case 'time':
      return timePart(d, s);
    case 'smalldatetime':
      return `${datePart(d)} ${timePart(d, 0)}`;
    case 'datetime':
      return `${datePart(d)} ${timePart(d, 3)}`;
    case 'datetimeoffset':
      // tedious converts to the UTC instant and drops the original offset.
      return `${datePart(d)} ${timePart(d, s)} +00:00`;
    default:
      return `${datePart(d)} ${timePart(d, s)}`;
  }
}

/**
 * DECIMAL text padded to the column scale. tedious delivers a JS number, so
 * start from its shortest round-trip form (String) and pad with zeros:
 * toFixed would print binary noise (0.1 at scale 18 -> 0.100000000000000006).
 */
export function decimalText(v: unknown, scale: number | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  let s = String(v);
  if (/e/i.test(s)) {
    // Exponent form only for tiny or huge magnitudes; toFixed is exact enough at those scales.
    if (Math.abs(v) >= 1e21) return s;
    s = v.toFixed(Math.min(Math.max(scale ?? 0, 0), 100));
  }
  if (!scale || scale <= 0) return s;
  const [whole, frac = ''] = s.split('.');
  return frac.length >= scale ? s : `${whole}.${frac.padEnd(scale, '0')}`;
}

/** A value whose column type is unknown (sql_variant) or unexpected: classify by JS type. */
function byJsType(v: unknown): Value {
  if (typeof v === 'boolean') return { t: 'bool', v };
  if (typeof v === 'number') return Number.isInteger(v) ? { t: 'int', v: String(v) } : { t: 'float', v };
  if (typeof v === 'bigint') return { t: 'int', v: v.toString() };
  if (typeof v === 'string') return { t: 'text', v };
  if (v instanceof Date) return { t: 'datetime', v: formatMssqlDate(v, 'datetime2', 7) };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return bytesValue(v);
  return { t: 'json', v };
}

export function mssqlValue(c: MssqlColumn, v: unknown): Value {
  if (v === null || v === undefined) return { t: 'null' };
  const decl = c.declaration;
  if (decl === 'bit') return typeof v === 'boolean' ? { t: 'bool', v } : byJsType(v);
  if (INT_TYPES.has(decl)) return { t: 'int', v: String(v) };
  if (DECIMAL_TYPES.has(decl)) {
    const scale = decl === 'money' || decl === 'smallmoney' ? 4 : c.scale;
    return { t: 'decimal', v: decimalText(v, scale) };
  }
  if (FLOAT_TYPES.has(decl)) return typeof v === 'number' ? { t: 'float', v } : byJsType(v);
  if (v instanceof Date) return { t: 'datetime', v: formatMssqlDate(v, decl, c.scale) };
  if (BINARY_TYPES.has(decl) || Buffer.isBuffer(v)) return Buffer.isBuffer(v) || v instanceof Uint8Array ? bytesValue(v) : byJsType(v);
  if (typeof v === 'string') {
    if (c.name === FOR_JSON_COLUMN) {
      try {
        return { t: 'json', v: JSON.parse(v) };
      } catch {
        return { t: 'text', v };
      }
    }
    return { t: 'text', v };
  }
  return byJsType(v);
}

/** How a `Value` is bound as a parameter; the driver maps `type` to an mssql type. */
export interface MssqlParam {
  type: 'nvarchar' | 'bit' | 'float' | 'varbinary';
  value: string | boolean | number | Buffer;
}

/**
 * Integers, decimals, dates, GUIDs, and text bind as NVARCHAR and let the
 * server convert to the column type: exact for BIGINT and DECIMAL (no JS
 * number in between) and valid for every temporal type we render.
 */
export function mssqlParam(v: Exclude<Value, { t: 'null' }>): MssqlParam {
  switch (v.t) {
    case 'bool':
      return { type: 'bit', value: v.v };
    case 'float':
      return { type: 'float', value: v.v };
    case 'bytes':
      return { type: 'varbinary', value: bytesFromValue(v) };
    case 'json':
      return { type: 'nvarchar', value: JSON.stringify(v.v) };
    case 'datetime':
      return { type: 'nvarchar', value: mssqlDateTimeText(v.v) };
    default:
      return { type: 'nvarchar', value: v.v };
  }
}

/** Render a sys.types name with its length/precision/scale, as in a column definition. */
export function renderMssqlType(type: string, maxLength: number, precision: number, scale: number): string {
  switch (type) {
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return maxLength === -1 ? `${type}(max)` : `${type}(${maxLength})`;
    case 'nvarchar':
    case 'nchar':
      return maxLength === -1 ? `${type}(max)` : `${type}(${maxLength / 2})`;
    case 'decimal':
    case 'numeric':
      return `${type}(${precision}, ${scale})`;
    case 'datetime2':
    case 'datetimeoffset':
    case 'time':
      return `${type}(${scale})`;
    default:
      return type;
  }
}
