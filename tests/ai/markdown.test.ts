import { describe, expect, it } from 'vitest';

/*
 * The parser lives in the renderer, which tsconfig.node.json (a composite
 * project) does not include, so it is loaded by path at runtime and typed here.
 */
type Inline = { t: string; v?: string; c?: Inline[]; href?: string };
type Block = { t: string; [k: string]: unknown };
interface MarkdownModule {
  parseMarkdown(src: string): Block[];
  parseInline(src: string): Inline[];
  inlineText(nodes: Inline[]): string;
}
interface SqlTokensModule {
  tokenizeSql(sql: string): { k: string; v: string }[];
}
const AI_DIR = '../../src/renderer/src/lib/components/ai/';
const { parseMarkdown, parseInline, inlineText } = (await import(/* @vite-ignore */ `${AI_DIR}markdown`)) as MarkdownModule;
const { tokenizeSql } = (await import(/* @vite-ignore */ `${AI_DIR}sql-tokens`)) as SqlTokensModule;

describe('markdown blocks', () => {
  it('parses headings, paragraphs, and rules', () => {
    expect(parseMarkdown('## Title\n\nFirst line\nsecond line\n\n---')).toEqual([
      { t: 'h', level: 2, c: [{ t: 'text', v: 'Title' }] },
      { t: 'p', c: [{ t: 'text', v: 'First line' }, { t: 'br' }, { t: 'text', v: 'second line' }] },
      { t: 'hr' }
    ]);
  });

  it('parses fenced code and marks an unterminated fence as open (streaming)', () => {
    expect(parseMarkdown('```sql\nSELECT 1;\n```')).toEqual([{ t: 'code', lang: 'sql', v: 'SELECT 1;', open: false }]);
    expect(parseMarkdown('Here:\n```sql\nSELECT')).toEqual([
      { t: 'p', c: [{ t: 'text', v: 'Here:' }] },
      { t: 'code', lang: 'sql', v: 'SELECT', open: true }
    ]);
  });

  it('keeps markdown inside code blocks literal', () => {
    const [b] = parseMarkdown('```\n**not bold** <b>x</b>\n```');
    expect(b).toEqual({ t: 'code', lang: '', v: '**not bold** <b>x</b>', open: false });
  });

  it('parses nested and ordered lists', () => {
    const blocks = parseMarkdown('1. one\n2. two\n   - a\n   - b\n3. three');
    expect(blocks).toHaveLength(1);
    const list = blocks[0];
    expect(list).toMatchObject({ t: 'list', ordered: true, start: 1 });
    const items = list.items as Block[][];
    expect(items).toHaveLength(3);
    expect(items[1][1]).toMatchObject({ t: 'list', ordered: false });
    expect(items[2]).toEqual([{ t: 'p', c: [{ t: 'text', v: 'three' }] }]);
  });

  it('parses GFM tables with alignment', () => {
    const [t] = parseMarkdown('| Status | Orders |\n|---|---:|\n| paid | 288 |\n| `x\\|y` | 1 |');
    expect(t).toMatchObject({ t: 'table', align: [null, 'right'] });
    expect((t.head as Inline[][]).map(inlineText)).toEqual(['Status', 'Orders']);
    expect((t.rows as Inline[][][]).map((r) => r.map(inlineText))).toEqual([
      ['paid', '288'],
      ['x|y', '1']
    ]);
  });

  it('parses blockquotes', () => {
    expect(parseMarkdown('> quoted\n> text')).toEqual([
      { t: 'quote', c: [{ t: 'p', c: [{ t: 'text', v: 'quoted' }, { t: 'br' }, { t: 'text', v: 'text' }] }] }
    ]);
  });
});

describe('markdown inline', () => {
  it('parses emphasis and code', () => {
    expect(parseInline('**bold** and *it* and `co*de` and ~~gone~~')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'bold' }] },
      { t: 'text', v: ' and ' },
      { t: 'em', c: [{ t: 'text', v: 'it' }] },
      { t: 'text', v: ' and ' },
      { t: 'code', v: 'co*de' },
      { t: 'text', v: ' and ' },
      { t: 'del', c: [{ t: 'text', v: 'gone' }] }
    ]);
  });

  it('does not treat snake_case as emphasis', () => {
    expect(parseInline('order_items and customer_id')).toEqual([{ t: 'text', v: 'order_items and customer_id' }]);
  });

  it('only links http(s) and mailto URLs', () => {
    expect(parseInline('[docs](https://example.com/a)')).toEqual([
      { t: 'link', href: 'https://example.com/a', c: [{ t: 'text', v: 'docs' }] }
    ]);
    expect(parseInline('[click](javascript:alert(1))')).not.toContainEqual(expect.objectContaining({ t: 'link' }));
    expect(parseInline('[f](file:///etc/passwd)')).toEqual([{ t: 'text', v: 'f' }]);
  });

  it('autolinks bare URLs without trailing punctuation', () => {
    expect(parseInline('See https://example.com/x.')).toEqual([
      { t: 'text', v: 'See ' },
      { t: 'link', href: 'https://example.com/x', c: [{ t: 'text', v: 'https://example.com/x' }] },
      { t: 'text', v: '.' }
    ]);
  });

  it('leaves raw HTML as plain text', () => {
    expect(parseInline('<img src=x onerror=alert(1)> <script>x</script>')).toEqual([
      { t: 'text', v: '<img src=x onerror=alert(1)> <script>x</script>' }
    ]);
  });

  it('honours backslash escapes', () => {
    expect(parseInline('\\*not em\\*')).toEqual([{ t: 'text', v: '*not em*' }]);
  });
});

describe('SQL tokens', () => {
  it('classifies keywords, functions, strings, numbers, and comments', () => {
    const kinds = tokenizeSql("SELECT count(*), 'a''b' FROM t -- note\nWHERE x = 1.5")
      .filter((t) => t.k !== 'text' && t.k !== 'op')
      .map((t) => `${t.k}:${t.v}`);
    expect(kinds).toEqual(['kw:SELECT', 'fn:count', "str:'a''b'", 'kw:FROM', 'com:-- note', 'kw:WHERE', 'num:1.5']);
  });

  it('round-trips the input text', () => {
    const sql = 'SELECT [Order Id], "x" FROM dbo.t /* c */ WHERE a <> 2;';
    expect(tokenizeSql(sql).map((t) => t.v).join('')).toBe(sql);
  });
});
