/**
 * Helpers for the tagged `Value` cell type, shared by main and renderer.
 */
import type { Value } from './types';

export const NULL_VALUE: Value = { t: 'null' };

export const text = (v: string): Value => ({ t: 'text', v });

export type TypeClass = 'int' | 'float' | 'decimal' | 'bool' | 'json' | 'datetime' | 'bytes' | 'text';

/** Coarse classification of a database type name, used for alignment, editors, and input parsing. */
export function classifyType(typeName: string): TypeClass {
  const t = typeName.trim().toLowerCase();
  if (/^(jsonb?|json\b)/.test(t)) return 'json';
  // Postgres arrays (`int4[]`, `text[]`, internal `_int4`) arrive as JSON arrays, not scalars.
  if (/\[\]$/.test(t) || /^_[a-z]/.test(t) || /^array\b/.test(t)) return 'json';
  if (/^(bool|boolean|bit)\b/.test(t) && !/^bit\s*\(\s*([2-9]|\d{2,})/.test(t)) return 'bool';
  if (/^(big|small|tiny|medium)?int(eger)?\b|^int[248]\b|^(big|small)?serial\b|^serial[248]?\b/.test(t)) return 'int';
  if (/^(real|float|float4|float8|double)\b/.test(t)) return 'float';
  if (/^(numeric|decimal|money|smallmoney|number)\b/.test(t)) return 'decimal';
  if (/^(date|time|timestamp|timestamptz|timetz|datetime|datetime2|smalldatetime|datetimeoffset|interval|year)\b/.test(t))
    return 'datetime';
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|image|rowversion)\b/.test(t)) return 'bytes';
  return 'text';
}

export function isNumericType(typeName: string): boolean {
  const c = classifyType(typeName);
  return c === 'int' || c === 'float' || c === 'decimal';
}

export function isNumericValue(v: Value): boolean {
  return v.t === 'int' || v.t === 'float' || v.t === 'decimal';
}

/** Single-line display text for a grid cell. */
export function displayValue(v: Value, maxLength = 2000): string {
  let s: string;
  switch (v.t) {
    case 'null':
      return 'NULL';
    case 'bool':
      s = v.v ? 'true' : 'false';
      break;
    case 'int':
    case 'decimal':
    case 'text':
    case 'datetime':
      s = v.v;
      break;
    case 'float':
      s = Number.isFinite(v.v) ? String(v.v) : String(v.v);
      break;
    case 'bytes':
      s = v.length <= 32 && !v.truncated ? `0x${v.hex}` : `<${v.length} bytes>`;
      break;
    case 'json':
      s = typeof v.v === 'string' ? v.v : JSON.stringify(v.v);
      break;
  }
  return s.length > maxLength ? `${s.slice(0, maxLength)}…` : s;
}

/** Full text used to seed a cell editor. NULL edits as the empty string. */
export function editText(v: Value): string {
  switch (v.t) {
    case 'null':
      return '';
    case 'json':
      return typeof v.v === 'string' ? v.v : JSON.stringify(v.v, null, 2);
    case 'bytes':
      return `\\x${v.hex}`;
    default:
      return displayValue(v, Number.MAX_SAFE_INTEGER);
  }
}

/** Plain JSON for exports and the AI. 64-bit ints outside the safe range stay strings; bytes become `\x` hex. */
export function valueToJson(v: Value): unknown {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v;
    case 'int': {
      const n = Number(v.v);
      return Number.isSafeInteger(n) ? n : v.v;
    }
    case 'float':
      return Number.isFinite(v.v) ? v.v : String(v.v);
    case 'decimal':
    case 'text':
    case 'datetime':
      return v.v;
    case 'bytes':
      return `\\x${v.hex}`;
    case 'json':
      return v.v;
  }
}

export interface FromInputOptions {
  /** The cell's value before editing; its tag decides the parse when present and non-null. */
  original?: Value;
  /** Declared column type; used when the original is NULL or absent. */
  columnType?: string;
  /** Treat empty input as NULL (default true). */
  emptyIsNull?: boolean;
}

/** Turn edited text back into a Value of the column's kind. Unparseable input becomes text and the database decides. */
export function valueFromInput(input: string, opts: FromInputOptions = {}): Value {
  const { original, columnType = '', emptyIsNull = true } = opts;
  if (input === '' && emptyIsNull) return NULL_VALUE;
  const cls: TypeClass =
    original && original.t !== 'null'
      ? original.t === 'float'
        ? 'float'
        : original.t === 'bytes'
          ? 'bytes'
          : (original.t as TypeClass)
      : classifyType(columnType);
  const trimmed = input.trim();
  switch (cls) {
    case 'json':
      try {
        return { t: 'json', v: JSON.parse(input) };
      } catch {
        return text(input);
      }
    case 'bool': {
      const l = trimmed.toLowerCase();
      if (['true', 't', '1', 'yes', 'y', 'on'].includes(l)) return { t: 'bool', v: true };
      if (['false', 'f', '0', 'no', 'n', 'off'].includes(l)) return { t: 'bool', v: false };
      return text(input);
    }
    case 'int':
      return /^[-+]?\d+$/.test(trimmed) ? { t: 'int', v: trimmed.replace(/^\+/, '') } : text(input);
    case 'float': {
      const n = Number(trimmed);
      return trimmed !== '' && !Number.isNaN(n) ? { t: 'float', v: n } : text(input);
    }
    case 'decimal':
      return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed) ? { t: 'decimal', v: trimmed } : text(input);
    case 'datetime':
      return { t: 'datetime', v: input };
    case 'bytes': {
      const m = /^(?:\\x|0x)?([0-9a-fA-F]*)$/.exec(trimmed);
      if (m && m[1].length % 2 === 0) {
        const hex = m[1].toLowerCase();
        return { t: 'bytes', hex, length: hex.length / 2 };
      }
      return text(input);
    }
    default:
      return text(input);
  }
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'null':
      return true;
    case 'bytes':
      return b.t === 'bytes' && a.hex === b.hex && a.length === b.length;
    case 'json':
      return b.t === 'json' && JSON.stringify(a.v) === JSON.stringify(b.v);
    default:
      return (a as { v: unknown }).v === (b as { v: unknown }).v;
  }
}
