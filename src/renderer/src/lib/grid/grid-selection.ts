/**
 * Grid selection model (display coordinates) and client-side sorting helpers.
 */
import type { Value } from '@shared/types';

export interface CellPos {
  row: number;
  col: number;
}

/** Inclusive rectangle; r0/c0 is the anchor corner, r1/c1 the moving corner. */
export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface NormRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function norm(r: CellRange): NormRange {
  return {
    top: Math.min(r.r0, r.r1),
    bottom: Math.max(r.r0, r.r1),
    left: Math.min(r.c0, r.c1),
    right: Math.max(r.c0, r.c1)
  };
}

export function rangeContains(r: CellRange, row: number, col: number): boolean {
  const n = norm(r);
  return row >= n.top && row <= n.bottom && col >= n.left && col <= n.right;
}

export function inRanges(ranges: CellRange[], row: number, col: number): boolean {
  for (const r of ranges) if (rangeContains(r, row, col)) return true;
  return false;
}

export function rowInRanges(ranges: CellRange[], row: number): boolean {
  for (const r of ranges) {
    const n = norm(r);
    if (row >= n.top && row <= n.bottom) return true;
  }
  return false;
}

/** Rows and columns touched by the selection, each sorted ascending. */
export function selectedAxes(ranges: CellRange[], maxCells = 2_000_000): { rows: number[]; cols: number[] } {
  const rows = new Set<number>();
  const cols = new Set<number>();
  let budget = maxCells;
  for (const r of ranges) {
    const n = norm(r);
    for (let c = n.left; c <= n.right; c++) cols.add(c);
    for (let row = n.top; row <= n.bottom && budget > 0; row++, budget--) rows.add(row);
  }
  return { rows: [...rows].sort((a, b) => a - b), cols: [...cols].sort((a, b) => a - b) };
}

export function cellCount(ranges: CellRange[]): number {
  if (ranges.length === 1) {
    const n = norm(ranges[0]);
    return (n.bottom - n.top + 1) * (n.right - n.left + 1);
  }
  const { rows, cols } = selectedAxes(ranges);
  let count = 0;
  for (const r of rows) for (const c of cols) if (inRanges(ranges, r, c)) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function bigintOf(s: string): bigint | null {
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function sortText(v: Value): string {
  switch (v.t) {
    case 'json':
      return typeof v.v === 'string' ? v.v : JSON.stringify(v.v);
    case 'bytes':
      return v.hex;
    case 'null':
      return '';
    case 'bool':
      return v.v ? '1' : '0';
    default:
      return String(v.v);
  }
}

/** Compare two non-null values ascending, type-aware. */
export function compareValues(a: Value, b: Value): number {
  if (a.t === 'int' && b.t === 'int') {
    if (a.v.length < 16 && b.v.length < 16) return Number(a.v) - Number(b.v);
    const x = bigintOf(a.v);
    const y = bigintOf(b.v);
    if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  }
  const numA = a.t === 'int' || a.t === 'float' || a.t === 'decimal' ? Number(a.v) : NaN;
  const numB = b.t === 'int' || b.t === 'float' || b.t === 'decimal' ? Number(b.v) : NaN;
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
  if (a.t === 'bool' && b.t === 'bool') return Number(a.v) - Number(b.v);
  if (a.t === 'datetime' && b.t === 'datetime') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  return collator.compare(sortText(a), sortText(b));
}

export interface ColumnSort {
  col: number;
  desc: boolean;
}

/** Stable permutation of row indexes; NULLs always last. */
export function sortPermutation(rows: Value[][], sort: ColumnSort[]): number[] {
  const idx = rows.map((_, i) => i);
  if (sort.length === 0) return idx;
  idx.sort((i, j) => {
    for (const s of sort) {
      const a = rows[i][s.col];
      const b = rows[j][s.col];
      if (!a || !b) continue;
      const an = a.t === 'null';
      const bn = b.t === 'null';
      if (an || bn) {
        if (an && bn) continue;
        return an ? 1 : -1;
      }
      const c = compareValues(a, b);
      if (c !== 0) return s.desc ? -c : c;
    }
    return i - j;
  });
  return idx;
}
