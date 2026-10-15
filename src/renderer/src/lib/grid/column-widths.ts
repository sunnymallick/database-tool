/**
 * Column width estimation for the results grid.
 */
import type { ResultColumn, Value } from '@shared/types';
import { displayValue } from '@shared/values';

export const MIN_COL = 64;
export const MAX_COL = 360;
export const MAX_FIT = 640;
/** Horizontal cell padding (both sides). */
const CELL_PAD = 18;
/** Header chrome next to the name: type label gap, key icon, sort indicator. */
const HEADER_EXTRA = 48;

let ctx: CanvasRenderingContext2D | null = null;
let monoCharWidth = 0;

function context(): CanvasRenderingContext2D | null {
  if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  return ctx;
}

function fontFamily(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

/** Width of one character in the 12px data font (monospace). */
export function charWidth(): number {
  if (monoCharWidth) return monoCharWidth;
  const c = context();
  if (!c) return 7.2;
  c.font = `12px ${fontFamily('--font-mono', 'ui-monospace, Menlo, monospace')}`;
  monoCharWidth = c.measureText('0000000000').width / 10 || 7.2;
  return monoCharWidth;
}

export function measureHeader(name: string, type: string): number {
  const c = context();
  if (!c) return name.length * 7.4 + type.length * 6 + HEADER_EXTRA;
  const sans = fontFamily('--font-sans', 'system-ui, sans-serif');
  c.font = `500 12px ${sans}`;
  const n = c.measureText(name).width;
  c.font = `10.5px ${sans}`;
  const t = type ? c.measureText(type).width + 6 : 0;
  return n + t + HEADER_EXTRA;
}

function cellChars(v: Value): number {
  return v.t === 'null' ? 4 : displayValue(v, 120).length;
}

/** Initial widths from the header and a sample of rows. */
export function estimateWidths(columns: ResultColumn[], rows: Value[][], sample = 200): number[] {
  const cw = charWidth();
  const n = Math.min(rows.length, sample);
  return columns.map((col, ci) => {
    let maxChars = 0;
    for (let r = 0; r < n; r++) {
      const v = rows[r][ci];
      if (v) maxChars = Math.max(maxChars, cellChars(v));
    }
    const w = Math.max(measureHeader(col.name, col.type), maxChars * cw + CELL_PAD);
    return Math.round(Math.min(MAX_COL, Math.max(MIN_COL, w)));
  });
}

/** Auto-fit width for one column (double-click on the resize edge). */
export function fitWidth(column: ResultColumn, values: Iterable<Value>, limit = 5000): number {
  const cw = charWidth();
  let maxChars = 0;
  let i = 0;
  for (const v of values) {
    if (i++ >= limit) break;
    maxChars = Math.max(maxChars, cellChars(v));
  }
  const w = Math.max(measureHeader(column.name, column.type), maxChars * cw + CELL_PAD);
  return Math.round(Math.min(MAX_FIT, Math.max(MIN_COL, w)));
}
