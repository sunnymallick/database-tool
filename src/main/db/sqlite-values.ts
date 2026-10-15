/**
 * SQLite storage values -> tagged `Value`s. Integers are read as BigInt so
 * 64-bit values survive; the declared column type refines the tag (BOOLEAN
 * 0/1 -> bool, NUMERIC -> decimal, JSON text -> json, DATE text -> datetime).
 */
import { classifyType } from '@shared/values';
import type { Value } from '@shared/types';
import { bytesFromValue, bytesValue } from './common';

/** What node:sqlite returns with setReadBigInts(true). */
export type SqliteRaw = null | bigint | number | string | Uint8Array;

export function sqliteStorageClass(v: SqliteRaw): string {
  if (v === null) return '';
  if (typeof v === 'bigint') return 'INTEGER';
  if (typeof v === 'number') return 'REAL';
  if (typeof v === 'string') return 'TEXT';
  return 'BLOB';
}

export function sqliteValue(raw: SqliteRaw, declared: string | null): Value {
  if (raw === null) return { t: 'null' };
  const cls = declared ? classifyType(declared) : null;
  if (raw instanceof Uint8Array) return bytesValue(raw);
  if (typeof raw === 'bigint') {
    if (cls === 'bool' && (raw === 0n || raw === 1n)) return { t: 'bool', v: raw === 1n };
    if (cls === 'decimal') return { t: 'decimal', v: raw.toString() };
    if (cls === 'float') return { t: 'float', v: Number(raw) };
    return { t: 'int', v: raw.toString() };
  }
  if (typeof raw === 'number') {
    if (cls === 'decimal' && Number.isFinite(raw)) return { t: 'decimal', v: String(raw) };
    return { t: 'float', v: raw };
  }
  if (cls === 'json') {
    try {
      return { t: 'json', v: JSON.parse(raw) };
    } catch {
      return { t: 'text', v: raw };
    }
  }
  if (cls === 'datetime') return { t: 'datetime', v: raw };
  return { t: 'text', v: raw };
}

/** A `Value` as a node:sqlite parameter. Decimals stay text so NUMERIC affinity converts them exactly as typed. */
export function sqliteParam(v: Value): null | bigint | number | string | Uint8Array {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v ? 1 : 0;
    case 'int':
      return /^-?\d+$/.test(v.v) ? BigInt(v.v) : v.v;
    case 'float':
      return v.v;
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

/** Best-effort offset for `near "tok": syntax error` within the statement text. */
export function sqliteErrorOffset(statement: string, message: string): number | undefined {
  const m = /near "([^"]*)": syntax error/.exec(message);
  if (!m || !m[1]) return undefined;
  const at = statement.indexOf(m[1]);
  return at === -1 ? undefined : at;
}
