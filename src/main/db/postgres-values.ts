/**
 * Postgres text-format values -> tagged `Value`s. The session and paging
 * queries install a type parser that returns raw server text for every type,
 * so this module is the only place values are interpreted (no JS Dates, no
 * lossy numbers).
 */
import type { Value } from '@shared/types';
import { bytesFromValue, hexValue } from './common';

export interface PgTypeInfo {
  oid: number;
  /** pg_type.typname, e.g. `int4`, `_text`, `my_enum`. */
  name: string;
  /** pg_type.typcategory: A array, B bool, D datetime, N numeric, S string, T timespan, U user, E enum, ... */
  category: string;
  /** Element type for arrays (category A). */
  elem?: PgTypeInfo;
  /** Base type for domains. */
  base?: PgTypeInfo;
}

const INT_TYPES = new Set(['int2', 'int4', 'int8', 'oid', 'xid', 'xid8', 'cid']);
const FLOAT_TYPES = new Set(['float4', 'float8']);
const DECIMAL_TYPES = new Set(['numeric', 'money']);
const DATETIME_TYPES = new Set(['date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval']);

/** Display name: arrays as `elem[]`, unknown OIDs as `oid:<n>`. */
export function pgTypeName(info: PgTypeInfo | undefined, oid: number): string {
  if (!info) return `oid:${oid}`;
  if (info.category === 'A' && info.elem) return `${info.elem.name}[]`;
  return info.name;
}

/** Decode bytea text output: hex (`\x0a0b`, the default) or the legacy escape format. */
export function pgByteaValue(raw: string): Value {
  if (raw.startsWith('\\x')) return hexValue(raw.slice(2));
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      if (raw[i + 1] === '\\') {
        bytes.push(92);
        i++;
      } else {
        bytes.push(parseInt(raw.slice(i + 1, i + 4), 8));
        i += 3;
      }
    } else bytes.push(raw.charCodeAt(i) & 0xff);
  }
  return hexValue(Buffer.from(bytes).toString('hex'));
}

/**
 * Parse an array literal (`{1,2}`, `{{"a,b",NULL}}`, `[0:1]={x,y}`) into
 * nested arrays of strings and nulls. Elements are converted by the caller.
 */
export function parsePgArray(text: string): unknown[] {
  let i = 0;
  if (text[0] === '[') {
    const eq = text.indexOf('=');
    i = eq === -1 ? 0 : eq + 1;
  }
  const n = text.length;
  const parse = (): unknown[] => {
    const out: unknown[] = [];
    i++; // '{'
    if (text[i] === '}') {
      i++;
      return out;
    }
    while (i < n) {
      if (text[i] === '{') out.push(parse());
      else if (text[i] === '"') {
        i++;
        let s = '';
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\') i++;
          s += text[i++];
        }
        i++;
        out.push(s);
      } else {
        let j = i;
        while (j < n && text[j] !== ',' && text[j] !== '}') j++;
        const s = text.slice(i, j).trim();
        out.push(/^null$/i.test(s) ? null : s);
        i = j;
      }
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') i++;
      break;
    }
    return out;
  };
  return text[i] === '{' ? parse() : [];
}

function baseOf(info: PgTypeInfo): PgTypeInfo {
  let t = info;
  for (let depth = 0; t.base && depth < 8; depth++) t = t.base;
  return t;
}

/** Array elements become JSON-friendly values: numbers when exact, booleans, parsed JSON, else text. */
function arrayElement(raw: unknown, elem: PgTypeInfo | undefined): unknown {
  if (raw === null || typeof raw !== 'string') return raw;
  const name = elem ? baseOf(elem).name : '';
  if (name === 'bool') return raw === 't';
  if (INT_TYPES.has(name)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : raw;
  }
  if (FLOAT_TYPES.has(name)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (name === 'json' || name === 'jsonb') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function mapArray(items: unknown[], elem: PgTypeInfo | undefined): unknown[] {
  return items.map((x) => (Array.isArray(x) ? mapArray(x, elem) : arrayElement(x, elem)));
}

export type PgMapper = (raw: string | null) => Value;

/** A converter for one result column, chosen once per column rather than per cell. */
export function pgMapper(info: PgTypeInfo | undefined): PgMapper {
  const t = info ? baseOf(info) : undefined;
  const name = t?.name ?? '';
  const wrap = (fn: (raw: string) => Value): PgMapper => (raw) => (raw === null ? { t: 'null' } : fn(raw));
  if (name === 'bool') return wrap((raw) => ({ t: 'bool', v: raw === 't' }));
  if (INT_TYPES.has(name)) return wrap((raw) => ({ t: 'int', v: raw }));
  if (FLOAT_TYPES.has(name)) return wrap((raw) => ({ t: 'float', v: Number(raw) }));
  if (DECIMAL_TYPES.has(name)) return wrap((raw) => ({ t: 'decimal', v: raw }));
  if (name === 'json' || name === 'jsonb') {
    return wrap((raw) => {
      try {
        return { t: 'json', v: JSON.parse(raw) };
      } catch {
        return { t: 'text', v: raw };
      }
    });
  }
  if (name === 'bytea') return wrap(pgByteaValue);
  if (DATETIME_TYPES.has(name)) return wrap((raw) => ({ t: 'datetime', v: raw }));
  if (t?.category === 'A') return wrap((raw) => ({ t: 'json', v: mapArray(parsePgArray(raw), t.elem) }));
  return wrap((raw) => ({ t: 'text', v: raw }));
}

export function pgValue(raw: string | null, info: PgTypeInfo | undefined): Value {
  return pgMapper(info)(raw);
}

/** A `Value` as a node-postgres parameter (text protocol; the server casts from context). */
export function pgParam(v: Value): unknown {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v;
    case 'float':
      return Number.isFinite(v.v) ? v.v : Number.isNaN(v.v) ? 'NaN' : v.v > 0 ? 'Infinity' : '-Infinity';
    case 'int':
    case 'decimal':
    case 'text':
    case 'datetime':
      return v.v;
    case 'json':
      // Stringify ourselves: node-postgres would turn a JS array into a Postgres array literal.
      return JSON.stringify(v.v);
    case 'bytes':
      return bytesFromValue(v);
  }
}
