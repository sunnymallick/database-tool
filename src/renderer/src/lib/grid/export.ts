/**
 * Serializers for copying and exporting result rows. Pure functions; the
 * grid passes the columns and rows it wants (selection or everything).
 */
import { qualifiedName, quoteIdent } from '@shared/sql';
import type { DbKind, ResultColumn, Value } from '@shared/types';
import { displayValue, valueToJson } from '@shared/values';

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql' | 'markdown';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string; filter: string }[] = [
  { id: 'csv', label: 'CSV', ext: 'csv', filter: 'CSV' },
  { id: 'json', label: 'JSON', ext: 'json', filter: 'JSON' },
  { id: 'sql', label: 'SQL INSERT', ext: 'sql', filter: 'SQL' },
  { id: 'markdown', label: 'Markdown', ext: 'md', filter: 'Markdown' },
  { id: 'tsv', label: 'TSV', ext: 'tsv', filter: 'TSV' }
];

export interface TableName {
  schema: string;
  table: string;
}

/** Full, untruncated text of a value (NULL -> `nullText`). */
export function plainText(v: Value, nullText = 'NULL'): string {
  switch (v.t) {
    case 'null':
      return nullText;
    case 'json':
      return typeof v.v === 'string' ? v.v : JSON.stringify(v.v);
    case 'bytes':
      return `\\x${v.hex}`;
    default:
      return displayValue(v, Number.MAX_SAFE_INTEGER);
  }
}

function tsvField(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Tab-separated values (clipboard friendly; fields with tabs/newlines/quotes are quoted). */
export function toTsv(columns: ResultColumn[], rows: Value[][], opts: { headers?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.headers) lines.push(columns.map((c) => tsvField(c.name)).join('\t'));
  for (const row of rows) lines.push(row.map((v) => tsvField(plainText(v))).join('\t'));
  return lines.join('\n');
}

function csvField(v: Value | string): string {
  if (typeof v !== 'string') {
    if (v.t === 'null') return '';
    v = plainText(v);
    if (v === '') return '""';
  }
  return /[",\n\r]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 CSV with a header row. NULL is an empty field, the empty string is `""`. */
export function toCsv(columns: ResultColumn[], rows: Value[][]): string {
  const lines = [columns.map((c) => csvField(c.name)).join(',')];
  for (const row of rows) lines.push(row.map((v) => csvField(v)).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Array of objects keyed by column name (duplicate names get a numeric suffix). */
export function toJson(columns: ResultColumn[], rows: Value[][]): string {
  const keys = uniqueNames(columns.map((c) => c.name));
  const out = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    keys.forEach((k, i) => (obj[k] = valueToJson(row[i])));
    return obj;
  });
  return JSON.stringify(out, null, 2);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = seen.get(n) ?? 0;
    seen.set(n, count + 1);
    return count === 0 ? n : `${n}_${count + 1}`;
  });
}

/** A SQL literal for the engine. */
export function sqlLiteral(kind: DbKind | null | undefined, v: Value): string {
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  switch (v.t) {
    case 'null':
      return 'NULL';
    case 'bool':
      if (kind === 'mssql' || kind === 'sqlite') return v.v ? '1' : '0';
      return v.v ? 'TRUE' : 'FALSE';
    case 'int':
    case 'decimal':
      return v.v;
    case 'float':
      return Number.isFinite(v.v) ? String(v.v) : quote(String(v.v));
    case 'text':
    case 'datetime':
      return kind === 'mssql' && /[^\x00-\x7f]/.test(v.v) ? `N${quote(v.v)}` : quote(v.v);
    case 'json':
      return quote(typeof v.v === 'string' ? v.v : JSON.stringify(v.v));
    case 'bytes':
      if (kind === 'postgres') return `'\\x${v.hex}'`;
      if (kind === 'sqlite') return `X'${v.hex}'`;
      return `0x${v.hex}`;
  }
}

/** One INSERT statement per row. */
export function toSqlInsert(
  kind: DbKind | null | undefined,
  table: TableName | null | undefined,
  columns: ResultColumn[],
  rows: Value[][]
): string {
  const k: DbKind = kind ?? 'postgres';
  const target = table ? qualifiedName(k, table.schema, table.table) : 'table_name';
  const cols = columns.map((c) => quoteIdent(k, c.name)).join(', ');
  return rows
    .map((row) => `INSERT INTO ${target} (${cols}) VALUES (${row.map((v) => sqlLiteral(k, v)).join(', ')});`)
    .join('\n');
}

function mdField(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** GitHub-flavored Markdown table; numeric columns are right-aligned. */
export function toMarkdown(columns: ResultColumn[], rows: Value[][]): string {
  const numeric = columns.map((_, i) => rows.length > 0 && rows.every((r) => r[i].t === 'null' || r[i].t === 'int' || r[i].t === 'float' || r[i].t === 'decimal'));
  const header = `| ${columns.map((c) => mdField(c.name)).join(' | ')} |`;
  const sep = `| ${columns.map((_, i) => (numeric[i] ? '---:' : '---')).join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((v) => mdField(plainText(v))).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

export function serialize(
  format: ExportFormat,
  columns: ResultColumn[],
  rows: Value[][],
  opts: { kind?: DbKind | null; table?: TableName | null; headers?: boolean } = {}
): string {
  switch (format) {
    case 'csv':
      return toCsv(columns, rows);
    case 'tsv':
      return toTsv(columns, rows, { headers: opts.headers ?? true });
    case 'json':
      return toJson(columns, rows);
    case 'sql':
      return toSqlInsert(opts.kind, opts.table, columns, rows);
    case 'markdown':
      return toMarkdown(columns, rows);
  }
}
