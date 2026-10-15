/**
 * Small markdown parser for assistant replies. It produces a tree of plain
 * data that Svelte renders as text nodes, so model output can never inject
 * HTML. Supports paragraphs, headings, ordered/unordered (nested) lists,
 * blockquotes, fenced code, GFM tables, horizontal rules, and inline code,
 * bold, italic, strikethrough, links, and bare URLs.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  /** `open`: the closing fence has not streamed in yet. */
  | { t: 'code'; lang: string; v: string; open: boolean }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function stripIndent(line: string, n: number): string {
  let i = 0;
  let removed = 0;
  while (i < line.length && removed < n && (line[i] === ' ' || line[i] === '\t')) {
    removed += line[i] === '\t' ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      cur += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

export function parseMarkdown(src: string): Block[] {
  return parseLines(src.replace(/\r\n?/g, '\n').split('\n'));
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const indent = indentOf(line);
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trim();
        if (t.startsWith(marker[0].repeat(marker.length)) && /^(`+|~+)$/.test(t) && t[0] === marker[0]) {
          closed = true;
          i++;
          break;
        }
        body.push(stripIndent(l, indent));
        i++;
      }
      blocks.push({ t: 'code', lang: fence[2].toLowerCase(), v: body.join('\n'), open: !closed });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1].length, c: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const q = QUOTE.exec(lines[i]);
        inner.push(q ? q[1] : lines[i]);
        i++;
      }
      blocks.push({ t: 'quote', c: parseLines(inner) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align: Align[] = splitRow(lines[i + 1]).map((d) => {
        const l = d.startsWith(':');
        const r = d.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? '')));
        i++;
      }
      blocks.push({ t: 'table', align: head.map((_, k) => align[k] ?? null), head: head.map((h) => parseInline(h)), rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const r = parseList(lines, i);
      blocks.push(r.block);
      i = r.next;
      continue;
    }

    // Paragraph: until a blank line or the start of another block.
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) break;
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const baseIndent = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m || indentOf(lines[i]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = baseIndent + m[2].length + Math.max(1, Math.min(m[3].length, 4));
    const body: string[] = [m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // A blank line continues the item only if indented content follows.
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent) {
          for (let k = i; k < j; k++) body.push('');
          i = j;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= contentIndent || (ind > baseIndent && LIST_ITEM.test(l))) {
        body.push(stripIndent(l, Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      if (ind <= baseIndent && (LIST_ITEM.test(l) || startsBlock(l))) break;
      // Lazy continuation of the item's paragraph.
      body.push(l.trim());
      i++;
    }
    items.push(parseLines(body));
    // Skip blank lines between items of the same list.
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j < lines.length && j !== i) {
      const nm = LIST_ITEM.exec(lines[j]);
      if (nm && indentOf(lines[j]) === baseIndent && /\d/.test(nm[2]) === ordered) i = j;
    }
  }
  return { block: { t: 'list', ordered, start: startNum, items }, next: i };
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function safeHref(href: string): string | null {
  const h = href.trim();
  return SAFE_URL.test(h) ? h : null;
}

function findClosing(s: string, from: number, delim: string): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === '`') {
      // Skip code spans.
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end === -1) return -1;
      i = end + run.length;
      continue;
    }
    if (s.startsWith(delim, i)) return i;
    i++;
  }
  return -1;
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)![0];
      const end = src.indexOf(run, i + run.length);
      if (end !== -1) {
        flush();
        let code = src.slice(i + run.length, end);
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        out.push({ t: 'code', v: code });
        i = end + run.length;
        continue;
      }
      buf += run;
      i += run.length;
      continue;
    }
    if (rest.startsWith('**') || rest.startsWith('__')) {
      const d = rest.slice(0, 2);
      const end = findClosing(src, i + 2, d);
      if (end > i + 2 && !(d === '__' && isWordChar(src[i - 1]))) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith('~~')) {
      const end = findClosing(src, i + 2, '~~');
      if (end > i + 2) {
        flush();
        out.push({ t: 'del', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] !== ch && src[i + 1] !== ' ' && src[i + 1] !== undefined) {
      const okStart = ch === '*' || !isWordChar(src[i - 1]);
      const end = okStart ? findClosing(src, i + 1, ch) : -1;
      if (end > i + 1 && src[end - 1] !== ' ' && (ch === '*' || !isWordChar(src[end + 1]))) {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (m) {
        flush();
        const href = safeHref(m[2]);
        const label = parseInline(m[1] || m[2]);
        if (href) out.push({ t: 'link', href, c: label });
        else out.push(...label);
        i += m[0].length;
        continue;
      }
    }
    if (ch === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(rest);
      if (m) {
        flush();
        out.push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] });
        i += m[0].length;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && !isWordChar(src[i - 1])) {
      const m = /^https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*/i.exec(rest);
      if (m) {
        let url = m[0];
        while (/[.,;:!?'"*_)\]]$/.test(url)) url = url.slice(0, -1);
        flush();
        out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] });
        i += url.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Plain text of inline nodes (for titles and copy). */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : 'c' in n ? inlineText(n.c) : ''))
    .join('');
}
