/**
 * Saving result sets to disk: one result in any format (including .xlsx), or
 * every result of a run at once as separate CSV files or one workbook. The
 * main process remembers the last folder saved to this session, so passing a
 * bare file name as defaultPath reopens the dialog there.
 */
import { toast } from 'svelte-sonner';
import type { DbKind, ResultColumn, ResultSet, Value } from '@shared/types';
import { call, errorMessage } from '$lib/api.svelte';
import { isMac } from '$lib/keys';
import { basename, formatCount } from '$lib/utils';
import { EXPORT_FORMATS, serialize, toCsv, type ExportFormat, type TableName } from './export';
import { buildXlsx, exceedsExcelRows } from './xlsx';

export type FileExportFormat = ExportFormat | 'xlsx';

export const XLSX_FORMAT = { id: 'xlsx' as const, label: 'Excel (.xlsx)', ext: 'xlsx', filter: 'Excel Workbook' };

/** Every single-result save format: CSV, Excel, then the text formats. */
export const FILE_EXPORT_FORMATS: { id: FileExportFormat; label: string; ext: string; filter: string }[] = [
  ...EXPORT_FORMATS.filter((f) => f.id === 'csv'),
  XLSX_FORMAT,
  ...EXPORT_FORMATS.filter((f) => f.id !== 'csv')
];

/** File-name-safe text (also used for sheet and file names derived from tab titles). */
export function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'result';
}

function revealAction(path: string) {
  return {
    label: isMac ? 'Show in Finder' : 'Show in Folder',
    onClick: () => void call('shell.showItemInFolder', { path }).catch(() => {})
  };
}

function plural(n: number, word: string): string {
  return `${formatCount(n)} ${n === 1 ? word : `${word}s`}`;
}

export interface SingleExport {
  format: FileExportFormat;
  columns: ResultColumn[];
  rows: Value[][];
  /** Default file name without extension. */
  name: string;
  kind?: DbKind | null;
  table?: TableName | null;
}

/** Ask where to save one result set and write it. */
export async function exportResult(opts: SingleExport): Promise<void> {
  const spec = opts.format === 'xlsx' ? XLSX_FORMAT : EXPORT_FORMATS.find((f) => f.id === opts.format)!;
  try {
    const path = await call('dialog.saveFile', {
      title: `Export ${spec.label}`,
      defaultPath: `${safeName(opts.name)}.${spec.ext}`,
      filters: [{ name: spec.filter, extensions: [spec.ext] }]
    });
    if (!path) return;
    if (opts.format === 'xlsx') {
      const data = buildXlsx([{ name: safeName(opts.name), columns: opts.columns, rows: opts.rows }]);
      await call('files.writeBytes', { path, data });
    } else {
      const content = serialize(opts.format, opts.columns, opts.rows, { kind: opts.kind, table: opts.table, headers: true });
      await call('files.write', { path, content });
    }
    toast.success(`Exported ${plural(opts.rows.length, 'row')}`, { description: basename(path), action: revealAction(path) });
  } catch (err) {
    toast.error('Export failed', { description: errorMessage(err) });
  }
}

/** Result sets with columns, in run order, labeled the way the result tabs are. */
export function exportableResults(results: ResultSet[]): { label: string; result: ResultSet }[] {
  const withRows = results.filter((r) => r.columns.length > 0);
  return withRows.map((result, i) => {
    const table = result.editable?.table;
    const label = withRows.length > 1 ? `Result ${i + 1}` : 'Result';
    return { label: table ? `${label} (${table})` : label, result };
  });
}

/** Save every result of a run: separate CSV files in a chosen folder, or one workbook with a sheet per result. */
export async function exportAllResults(results: ResultSet[], format: 'csv' | 'xlsx', baseName: string): Promise<void> {
  const items = exportableResults(results);
  if (items.length === 0) return;
  const base = safeName(baseName);
  const totalRows = items.reduce((n, it) => n + it.result.rows.length, 0);
  try {
    if (format === 'csv') {
      const dir = await call('dialog.openDirectory', {
        title: `Choose a folder for ${plural(items.length, 'CSV file')}`,
        buttonLabel: 'Export Here'
      });
      if (!dir) return;
      const files = items.map((it) => ({
        name: `${base} - ${safeName(it.label)}.csv`,
        content: toCsv(it.result.columns, it.result.rows)
      }));
      const { paths } = await call('files.writeToDirectory', { dir, files });
      toast.success(`Exported ${plural(paths.length, 'CSV file')}`, {
        description: `${plural(totalRows, 'row')} in ${basename(dir)}`,
        action: revealAction(paths[0])
      });
      return;
    }

    const path = await call('dialog.saveFile', {
      title: `Export ${plural(items.length, 'result')} to Excel`,
      defaultPath: `${base}.xlsx`,
      filters: [{ name: XLSX_FORMAT.filter, extensions: ['xlsx'] }]
    });
    if (!path) return;
    const sheets = items.map((it) => ({ name: it.label, columns: it.result.columns, rows: it.result.rows }));
    // A last sheet maps each result sheet back to the SQL that produced it.
    sheets.push({
      name: 'Queries',
      columns: [
        { name: 'sheet', type: 'text' },
        { name: 'rows', type: 'int' },
        { name: 'truncated', type: 'bool' },
        { name: 'sql', type: 'text' }
      ],
      rows: items.map((it) => [
        { t: 'text', v: it.label },
        { t: 'int', v: String(it.result.rows.length) },
        { t: 'bool', v: it.result.truncated },
        { t: 'text', v: it.result.statement }
      ])
    });
    const data = buildXlsx(sheets);
    await call('files.writeBytes', { path, data });
    const tooBig = items.some((it) => exceedsExcelRows(it.result.rows.length));
    toast.success(`Exported ${plural(items.length, 'sheet')}`, {
      description: `${plural(totalRows, 'row')} in ${basename(path)}${tooBig ? ' (rows past Excel’s 1,048,576 limit were dropped)' : ''}`,
      action: revealAction(path)
    });
  } catch (err) {
    toast.error('Export failed', { description: errorMessage(err) });
  }
}
