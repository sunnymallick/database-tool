/**
 * Minimal Office Open XML (.xlsx) writer for query results: one worksheet per
 * result set, bold frozen header row, typed cells (numbers, booleans, text).
 * Hand-rolled SpreadsheetML zipped with fflate, so there is no heavy spreadsheet
 * dependency; it only needs to write, never read.
 */
import { zipSync, strToU8 } from 'fflate';
import type { ResultColumn, Value } from '@shared/types';
import { plainText } from './export';

export interface XlsxSheet {
  name: string;
  columns: ResultColumn[];
  rows: Value[][];
}

/** Excel's hard limits. */
const MAX_ROWS = 1_048_576;
const MAX_CELL_CHARS = 32_767;

/** Characters XML 1.0 can't carry (control chars other than tab/newline/CR, lone surrogates, U+FFFE/F). */
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function xml(s: string): string {
  return s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 0 -> A, 25 -> Z, 26 -> AA ... */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Sheet names: max 31 chars, none of []:*?/\, not wrapped in apostrophes, unique (case-insensitive). */
export function sheetNames(requested: string[]): string[] {
  const used = new Set<string>();
  return requested.map((raw, i) => {
    const base = (raw.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim() || `Sheet ${i + 1}`).slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function textCell(ref: string, text: string, style = 0): string {
  const t = text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text;
  const s = style ? ` s="${style}"` : '';
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
}

/** A number Excel can hold without changing the digits, or null to fall back to text. */
function exactNumber(text: string): number | null {
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const digits = text.replace(/^[-+]/, '').replace(/^0+(?=\d)/, '').replace('.', '').replace(/^0+/, '');
  return digits.replace(/0+$/, '').length <= 15 ? n : null;
}

function valueCell(ref: string, v: Value): string {
  switch (v.t) {
    case 'null':
      return '';
    case 'bool':
      return `<c r="${ref}" t="b"><v>${v.v ? 1 : 0}</v></c>`;
    case 'int':
    case 'decimal': {
      const n = exactNumber(v.v);
      return n === null ? textCell(ref, v.v) : `<c r="${ref}"><v>${n}</v></c>`;
    }
    case 'float':
      return Number.isFinite(v.v) ? `<c r="${ref}"><v>${v.v}</v></c>` : textCell(ref, String(v.v));
    default:
      return textCell(ref, plainText(v));
  }
}

/** Rough column widths (in characters) from the header and the first rows. */
function columnWidths(sheet: XlsxSheet): number[] {
  const sample = sheet.rows.slice(0, 300);
  return sheet.columns.map((c, i) => {
    let w = c.name.length + 2;
    for (const row of sample) {
      const v = row[i];
      if (!v || v.t === 'null') continue;
      const len = v.t === 'json' || v.t === 'text' ? plainText(v).split('\n', 1)[0].length : plainText(v).length;
      if (len > w) w = len;
      if (w >= 60) break;
    }
    return Math.max(6, Math.min(60, w + 1));
  });
}

function worksheet(sheet: XlsxSheet): string {
  const out: string[] = [];
  const lastCol = columnLetter(Math.max(0, sheet.columns.length - 1));
  const rowCount = Math.min(sheet.rows.length, MAX_ROWS - 1);
  out.push(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<dimension ref="A1:${lastCol}${rowCount + 1}"/>`,
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>'
  );
  if (sheet.columns.length > 0) {
    out.push('<cols>');
    columnWidths(sheet).forEach((w, i) => out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`));
    out.push('</cols>');
  }
  out.push('<sheetData>');
  out.push(`<row r="1">${sheet.columns.map((c, i) => textCell(`${columnLetter(i)}1`, c.name, 1)).join('')}</row>`);
  const letters = sheet.columns.map((_, i) => columnLetter(i));
  for (let r = 0; r < rowCount; r++) {
    const rowNum = r + 2;
    const row = sheet.rows[r];
    let cells = '';
    for (let c = 0; c < letters.length; c++) cells += valueCell(`${letters[c]}${rowNum}`, row[c] ?? { t: 'null' });
    out.push(`<row r="${rowNum}">${cells}</row>`);
  }
  out.push('</sheetData>', '</worksheet>');
  return out.join('');
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** Build an .xlsx workbook. Rows past Excel's limit are dropped (the caller should warn). */
export function buildXlsx(input: XlsxSheet[]): Uint8Array {
  const sheets = input.length > 0 ? input : [{ name: 'Sheet 1', columns: [], rows: [] }];
  const names = sheetNames(sheets.map((s) => s.name));
  const files: Record<string, Uint8Array> = {};

  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>'
  );
  files['_rels/.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  );
  files['xl/workbook.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView/></bookViews><sheets>' +
      names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>'
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>'
  );
  files['xl/styles.xml'] = strToU8(STYLES);
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(worksheet(s))));

  return zipSync(files, { level: 6 });
}

/** True when a sheet has more rows than Excel can hold. */
export function exceedsExcelRows(rows: number): boolean {
  return rows > MAX_ROWS - 1;
}
