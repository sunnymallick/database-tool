/**
 * Output formatting for the db-tool CLI: aligned text tables for people,
 * JSON/CSV/TSV for scripts and agents.
 */
import type { ResultSet, Value } from '@shared/types';
import { displayValue, valueToJson } from '@shared/values';

export const FORMATS = ['table', 'json', 'csv', 'tsv'] as const;
export type Format = (typeof FORMATS)[number];

/** Widest a text-table column gets before cells are cut with an ellipsis. */
const MAX_COL_WIDTH = 60;

function oneLine(s: string): string {
  return s.replace(/\r?\n/g, '⏎').replace(/\t/g, ' ');
}

function cut(s: string, width: number): string {
  return s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s;
}

/** Render rows of strings as an aligned table with a header rule. */
export function textTable(headers: string[], rows: string[][]): string {
  const cells = rows.map((r) => r.map((c) => cut(oneLine(c), MAX_COL_WIDTH)));
  const head = headers.map((h) => cut(oneLine(h), MAX_COL_WIDTH));
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}

function delimited(rows: string[][], sep: ',' | '\t'): string {
  const esc = (s: string): string => {
    if (sep === '\t') return s.replace(/[\t\r\n]/g, ' ');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(sep)).join('\n');
}

const cellText = (v: Value): string => (v.t === 'null' ? '' : displayValue(v, Number.MAX_SAFE_INTEGER));

/** Unique keys for row objects when a result repeats a column name. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = (seen.get(n) ?? 0) + 1;
    seen.set(n, count);
    return count === 1 ? n : `${n}_${count}`;
  });
}

export function resultSetJson(rs: ResultSet): Record<string, unknown> {
  const keys = uniqueNames(rs.columns.map((c) => c.name));
  const out: Record<string, unknown> = {
    columns: rs.columns.map((c) => ({ name: c.name, type: c.type })),
    rows: rs.rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, valueToJson(r[i])]))),
    row_count: rs.rows.length
  };
  if (rs.truncated) out.truncated = true;
  if (rs.rowsAffected !== undefined && rs.rowsAffected !== null) out.rows_affected = rs.rowsAffected;
  if (rs.messages?.length) out.messages = rs.messages;
  return out;
}

/** JSON indented for a terminal, compact when piped (agents pay per token). */
export function jsonText(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** Render query results. JSON is always an array with one entry per result set. */
export function formatResults(results: ResultSet[], format: Format, pretty = true): string {
  if (format === 'json') return jsonText(results.map(resultSetJson), pretty);
  const blocks = results.map((rs) => {
    if (rs.columns.length === 0) {
      return format === 'table' ? `(${rs.rowsAffected ?? 0} rows affected)` : '';
    }
    const header = rs.columns.map((c) => c.name);
    if (format === 'table') {
      const rows = rs.rows.map((r) => r.map((v) => displayValue(v, MAX_COL_WIDTH * 2)));
      const footer = `(${rs.rows.length} row${rs.rows.length === 1 ? '' : 's'}${rs.truncated ? ', more rows exist; raise --limit' : ''})`;
      const messages = rs.messages?.length ? `\n${rs.messages.join('\n')}` : '';
      return `${textTable(header, rows)}\n${footer}${messages}`;
    }
    return delimited([header, ...rs.rows.map((r) => r.map(cellText))], format === 'csv' ? ',' : '\t');
  });
  return blocks.filter((b) => b !== '').join('\n\n');
}

/** Render a list of plain records (connections, tables, columns) in any format. */
export function formatRecords(headers: string[], rows: string[][], format: Format, json: unknown, pretty = true): string {
  switch (format) {
    case 'json':
      return jsonText(json, pretty);
    case 'csv':
      return delimited([headers, ...rows], ',');
    case 'tsv':
      return delimited([headers, ...rows], '\t');
    default:
      return rows.length ? textTable(headers, rows) : '(none)';
  }
}
