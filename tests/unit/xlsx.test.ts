import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Value } from '../../src/shared/types';
import { buildXlsx, columnLetter, sheetNames } from '../../src/renderer/src/lib/grid/xlsx';

const cols = (...names: string[]) => names.map((name) => ({ name, type: 'text' }));

function parts(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

describe('columnLetter', () => {
  it('maps indexes to spreadsheet columns', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('sheetNames', () => {
  it('sanitizes, truncates to 31 chars, and de-duplicates case-insensitively', () => {
    const names = sheetNames(['Result 1 (orders)', 'a/b:c*d?e[f]g\\h', "'quoted'", 'x'.repeat(40), 'Result 1 (ORDERS)', '']);
    expect(names[0]).toBe('Result 1 (orders)');
    expect(names[1]).toBe('a b c d e f g h');
    expect(names[2]).toBe('quoted');
    expect(names[3]).toHaveLength(31);
    expect(names[4]).toBe('Result 1 (ORDERS) (2)');
    expect(names[5]).toBe('Sheet 6');
  });
});

describe('buildXlsx', () => {
  const rows: Value[][] = [
    [{ t: 'int', v: '42' }, { t: 'text', v: 'a & <b> "c"' }, { t: 'bool', v: true }, { t: 'null' }],
    [{ t: 'int', v: '9007199254740993' }, { t: 'text', v: 'bad\u0001char' }, { t: 'bool', v: false }, { t: 'decimal', v: '1234.50' }],
    [{ t: 'float', v: 0.25 }, { t: 'json', v: { k: [1, 2] } }, { t: 'datetime', v: '2026-10-13 09:00:00' }, { t: 'decimal', v: '12345678901234567.89' }]
  ];
  const bytes = buildXlsx([
    { name: 'Result 1', columns: cols('id', 'label', 'ok', 'amount'), rows },
    { name: 'Result 2', columns: cols('n'), rows: [] }
  ]);
  const p = parts(bytes);

  it('contains the required package parts', () => {
    expect(Object.keys(p).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml'
    ]);
    expect(p['xl/workbook.xml']).toContain('<sheet name="Result 1" sheetId="1" r:id="rId1"/>');
    expect(p['xl/workbook.xml']).toContain('<sheet name="Result 2" sheetId="2" r:id="rId2"/>');
    expect(p['xl/_rels/workbook.xml.rels']).toContain('Id="rId3"');
  });

  it('writes a bold frozen header row', () => {
    const s = p['xl/worksheets/sheet1.xml'];
    expect(s).toContain('state="frozen"');
    expect(s).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">id</t></is></c>');
    expect(s).toContain('<dimension ref="A1:D4"/>');
  });

  it('types cells and escapes text', () => {
    const s = p['xl/worksheets/sheet1.xml'];
    expect(s).toContain('<c r="A2"><v>42</v></c>');
    expect(s).toContain('a &amp; &lt;b&gt; &quot;c&quot;');
    expect(s).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(s).not.toContain('r="D2"'); // NULL -> no cell
    // Integers beyond double precision stay exact as text.
    expect(s).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">9007199254740993</t></is></c>');
    expect(s).toContain('badchar');
    expect(s).toContain('<c r="D3"><v>1234.5</v></c>');
    expect(s).toContain('<c r="A4"><v>0.25</v></c>');
    expect(s).toContain('{&quot;k&quot;:[1,2]}');
    expect(s).toContain('2026-10-13 09:00:00');
    expect(s).toContain('12345678901234567.89</t>'); // too many digits for a double -> text
  });

  it('handles an empty result set', () => {
    expect(p['xl/worksheets/sheet2.xml']).toContain('<row r="1"><c r="A1" t="inlineStr" s="1">');
  });
});
