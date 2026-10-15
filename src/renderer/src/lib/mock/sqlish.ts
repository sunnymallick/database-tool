/**
 * OWNER: workbench (UI) slice. A deliberately small SQL interpreter for the
 * mock backend: enough SELECT (projection, WHERE, GROUP BY with simple
 * aggregates, ORDER BY, LIMIT/OFFSET/TOP/FETCH, CTEs, subqueries in FROM),
 * INSERT/UPDATE/DELETE, and a few utility statements to make the UI feel
 * real in a browser. Anything it cannot understand degrades gracefully.
 */
import type { DbKind, EditableTarget, ResultColumn, Value } from '@shared/types';
import { classifyType, displayValue, valueFromInput, valuesEqual } from '@shared/values';
import { leadingKeyword, qualifiedName, quoteIdent } from '@shared/sql';
import { resolveTable, rowsOf, type MockColumn, type MockDatabase, type MockTable } from './catalog';
import { NUL, Rng, vBool, vDate, vDec, vFloat, vInt, vJson, vText } from './fixtures';

export class SqlError extends Error {
  readonly code?: string;
  /** Offset into the statement text the error refers to. */
  readonly pos?: number;
  readonly hint?: string;
  constructor(message: string, code?: string, pos?: number, hint?: string) {
    super(message);
    this.name = 'SqlError';
    this.code = code;
    this.pos = pos;
    this.hint = hint;
  }
}

export interface ColumnRef {
  name: string;
  type: string;
}

export interface Env {
  db: MockDatabase;
  kind: DbKind;
  database: string;
  user: string;
  version: string;
}

export interface StatementOutcome {
  columns: ResultColumn[];
  rows: Value[][];
  rowsAffected?: number;
  editable?: EditableTarget;
  messages?: string[];
}

// ---------------------------------------------------------------------------
// Type names per engine
// ---------------------------------------------------------------------------

type TypeKey = 'bigint' | 'int' | 'numeric' | 'float' | 'text' | 'timestamp' | 'bool' | 'date';
const TYPE_NAMES: Record<DbKind, Record<TypeKey, string>> = {
  postgres: { bigint: 'int8', int: 'int4', numeric: 'numeric', float: 'float8', text: 'text', timestamp: 'timestamptz', bool: 'bool', date: 'date' },
  mssql: { bigint: 'bigint', int: 'int', numeric: 'decimal', float: 'float', text: 'nvarchar', timestamp: 'datetime2', bool: 'bit', date: 'date' },
  mysql: { bigint: 'bigint', int: 'int', numeric: 'decimal', float: 'double', text: 'varchar', timestamp: 'datetime', bool: 'tinyint', date: 'date' },
  sqlite: { bigint: 'INTEGER', int: 'INTEGER', numeric: 'REAL', float: 'REAL', text: 'TEXT', timestamp: 'TEXT', bool: 'INTEGER', date: 'TEXT' }
};
export const typeName = (kind: DbKind, key: TypeKey): string => TYPE_NAMES[kind][key];

export function nowText(kind: DbKind): string {
  const iso = new Date().toISOString();
  switch (kind) {
    case 'postgres':
      return iso.replace('T', ' ').replace('Z', '+00');
    case 'mssql':
      return iso.replace('T', ' ').replace('Z', '0000');
    case 'mysql':
      return iso.replace('T', ' ').replace(/\.\d{3}Z$/, '');
    case 'sqlite':
      return iso.replace(/\.\d{3}Z$/, 'Z');
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export type TokKind = 'id' | 'qid' | 'str' | 'num' | 'op' | 'lp' | 'rp' | 'comma' | 'star' | 'dot';
export interface Tok {
  k: TokKind;
  v: string;
  pos: number;
  end: number;
  /** Opening quote character of a quoted identifier. */
  q?: string;
}

const TWO_CHAR_OPS = ['<=', '>=', '<>', '!=', '::', '||'];

export function tokenize(src: string, base = 0): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    const start = i;
    let q = i;
    if ((ch === 'N' || ch === 'n' || ch === 'E' || ch === 'e') && src[i + 1] === "'") q = i + 1;
    if (src[q] === "'") {
      let j = q + 1;
      let s = '';
      while (j < n) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += src[j];
        j++;
      }
      if (j >= n) throw new SqlError('unterminated quoted string', '42601', base + start);
      out.push({ k: 'str', v: s, pos: base + start, end: base + j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      let s = '';
      while (j < n) {
        if (src[j] === close) {
          if (src[j + 1] === close) {
            s += close;
            j += 2;
            continue;
          }
          break;
        }
        s += src[j];
        j++;
      }
      out.push({ k: 'qid', v: s, pos: base + start, end: base + Math.min(j + 1, n), q: ch });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_@#$\u0080-￿]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$@#\u0080-￿]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j), pos: base + i, end: base + j });
      i = j;
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0], pos: base + i, end: base + i + m[0].length });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      out.push({ k: 'op', v: two, pos: base + i, end: base + i + 2 });
      i += 2;
      continue;
    }
    const single: Partial<Record<string, TokKind>> = { '(': 'lp', ')': 'rp', ',': 'comma', '*': 'star', '.': 'dot' };
    if (ch === ';') {
      i++;
      continue;
    }
    out.push({ k: single[ch] ?? 'op', v: ch, pos: base + i, end: base + i + 1 });
    i++;
  }
  return out;
}

const isWord = (t: Tok | undefined, w: string): boolean => !!t && t.k === 'id' && t.v.toUpperCase() === w;

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function isNumTag(v: Value): boolean {
  return v.t === 'int' || v.t === 'float' || v.t === 'decimal';
}

function toBoolNum(s: string): number | null {
  const l = s.trim().toLowerCase();
  if (['true', 't', '1', 'yes', 'y', 'on'].includes(l)) return 1;
  if (['false', 'f', '0', 'no', 'n', 'off'].includes(l)) return 0;
  return null;
}

export function toNum(v: Value): number | null {
  switch (v.t) {
    case 'int':
    case 'decimal':
      return Number(v.v);
    case 'float':
      return v.v;
    case 'bool':
      return v.v ? 1 : 0;
    case 'text': {
      const s = v.v.trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isNaN(n) ? null : n;
    }
    default:
      return null;
  }
}

function toStr(v: Value): string {
  if (v.t === 'datetime') return v.v.replace('T', ' ');
  return displayValue(v, Number.MAX_SAFE_INTEGER);
}

/** SQL comparison; null when either side is NULL. */
export function compareValues(a: Value, b: Value, ci = false): number | null {
  if (a.t === 'null' || b.t === 'null') return null;
  if (a.t === 'bool' || b.t === 'bool') {
    const x = a.t === 'text' ? toBoolNum(a.v) : toNum(a);
    const y = b.t === 'text' ? toBoolNum(b.v) : toNum(b);
    if (x !== null && y !== null) return x - y;
  }
  if (isNumTag(a) || isNumTag(b)) {
    const x = toNum(a);
    const y = toNum(b);
    if (x !== null && y !== null) {
      if (a.t === 'int' && b.t === 'int' && (a.v.length > 15 || b.v.length > 15)) {
        const bx = BigInt(a.v);
        const by = BigInt(b.v);
        return bx < by ? -1 : bx > by ? 1 : 0;
      }
      return x < y ? -1 : x > y ? 1 : 0;
    }
  }
  let x = toStr(a);
  let y = toStr(b);
  if (ci) {
    x = x.toLowerCase();
    y = y.toLowerCase();
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Sort order: NULLs last, then SQL comparison. */
export function sortCompare(a: Value, b: Value): number {
  if (a.t === 'null') return b.t === 'null' ? 0 : 1;
  if (b.t === 'null') return -1;
  return compareValues(a, b) ?? 0;
}

export function looseEqual(a: Value, b: Value): boolean {
  if (valuesEqual(a, b)) return true;
  if (a.t === 'null' || b.t === 'null') return false;
  return compareValues(a, b) === 0;
}

function textOf(v: Value): string {
  switch (v.t) {
    case 'null':
      return '';
    case 'json':
      return typeof v.v === 'string' ? v.v : JSON.stringify(v.v);
    case 'bytes':
      return `\\x${v.hex}`;
    default:
      return toStr(v);
  }
}

/** Convert a value to a column's type the way an engine would on assignment. */
export function coerceTo(v: Value, col: MockColumn, kind: DbKind): Value {
  if (v.t === 'null') return v;
  const cls = classifyType(col.type);
  let out: Value;
  if ((cls === 'int' && v.t === 'int') || (cls === 'decimal' && v.t === 'decimal') || (cls === 'float' && v.t === 'float') || cls === v.t) out = v;
  else if (cls === 'text' && v.t === 'json' && /^_|\[\]$/.test(col.type)) out = v;
  else if (cls === 'text') out = v.t === 'text' ? v : vText(textOf(v));
  else if (cls === 'json' && v.t === 'text') {
    try {
      out = vJson(JSON.parse(v.v));
    } catch {
      throw new SqlError(`invalid input syntax for type json`, '22P02', undefined, `Token "${v.v.slice(0, 20)}" is invalid.`);
    }
  } else if (cls === 'decimal' && isNumTag(v)) out = vDec(String(toNum(v)));
  else if (cls === 'float' && isNumTag(v)) out = vFloat(toNum(v) ?? 0);
  else if (cls === 'int' && isNumTag(v)) {
    const n = toNum(v) ?? 0;
    out = vInt(Math.round(n));
  } else if (cls === 'bool' && isNumTag(v)) out = vBool((toNum(v) ?? 0) !== 0);
  else {
    out = valueFromInput(textOf(v), { columnType: col.type, emptyIsNull: false });
    if (out.t === 'text' && (cls === 'int' || cls === 'float' || cls === 'decimal' || cls === 'bool'))
      throw new SqlError(`invalid input syntax for type ${col.type}: "${textOf(v)}"`, '22P02');
  }
  if (kind === 'sqlite') {
    if (out.t === 'bool') return vInt(out.v ? 1 : 0);
    if (out.t === 'json') return vText(JSON.stringify(out.v));
    if (out.t === 'decimal' && /^NUMERIC/i.test(col.type)) return vFloat(Number(out.v));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expression parser (WHERE conditions, select items, SET right-hand sides)
// ---------------------------------------------------------------------------

export interface Expr {
  get: (row: Value[]) => Value;
  type: string;
  /** Default output column name (pg-style). */
  name: string;
  /** Set for a bare column reference. */
  colIndex?: number;
}

type Pred = (row: Value[]) => boolean | null;

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const CMP_OPS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);
const NOT_ALIAS = new Set([
  'END', 'NULL', 'TRUE', 'FALSE', 'AND', 'OR', 'NOT', 'FROM', 'WHERE', 'AS', 'ASC', 'DESC', 'THEN', 'ELSE', 'WHEN', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'ON', 'JOIN'
]);

class ExprParser {
  i = 0;
  constructor(
    readonly toks: Tok[],
    readonly cols: ColumnRef[],
    readonly env: Env,
    readonly endPos: number
  ) {}

  peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  atEnd(): boolean {
    return this.i >= this.toks.length;
  }
  isKw(w: string, o = 0): boolean {
    return isWord(this.peek(o), w);
  }
  eatKw(w: string): boolean {
    if (!this.isKw(w)) return false;
    this.i++;
    return true;
  }
  expectKw(w: string): void {
    if (!this.eatKw(w)) this.fail();
  }
  eat(k: TokKind): boolean {
    if (this.peek()?.k !== k) return false;
    this.i++;
    return true;
  }
  expect(k: TokKind): Tok {
    const t = this.peek();
    if (!t || t.k !== k) this.fail();
    this.i++;
    return t;
  }
  fail(): never {
    const t = this.peek();
    if (!t) throw new SqlError('syntax error at end of input', '42601', this.endPos);
    throw new SqlError(`syntax error at or near "${t.k === 'str' ? `'${t.v}'` : t.v}"`, '42601', t.pos);
  }
  get ci(): boolean {
    return this.env.kind !== 'postgres';
  }

  // -- conditions --------------------------------------------------------

  parseCondition(): Pred {
    let left = this.parseAnd();
    while (this.eatKw('OR')) {
      const a = left;
      const b = this.parseAnd();
      left = (row) => {
        const x = a(row);
        if (x === true) return true;
        const y = b(row);
        if (y === true) return true;
        return x === null || y === null ? null : false;
      };
    }
    return left;
  }

  private parseAnd(): Pred {
    let left = this.parseNot();
    while (this.eatKw('AND')) {
      const a = left;
      const b = this.parseNot();
      left = (row) => {
        const x = a(row);
        if (x === false) return false;
        const y = b(row);
        if (y === false) return false;
        return x === null || y === null ? null : true;
      };
    }
    return left;
  }

  private parseNot(): Pred {
    if (this.eatKw('NOT')) {
      const c = this.parseNot();
      return (row) => {
        const x = c(row);
        return x === null ? null : !x;
      };
    }
    if (this.peek()?.k === 'lp' && !this.isKw('SELECT', 1)) {
      const save = this.i;
      try {
        this.i++;
        const inner = this.parseCondition();
        this.expect('rp');
        const next = this.peek();
        const continues = next && (next.k === 'op' || next.k === 'star' || isWord(next, 'IS') || isWord(next, 'LIKE') || isWord(next, 'IN'));
        if (!continues) return inner;
      } catch {
        // Not a parenthesized condition; reparse as an operand.
      }
      this.i = save;
    }
    if (this.isKw('EXISTS')) throw new SqlError('subqueries are not supported by the mock backend', '0A000', this.peek()!.pos);
    return this.parsePredicate();
  }

  private parsePredicate(): Pred {
    const left = this.parseExpr();
    if (this.eatKw('IS')) {
      const neg = this.eatKw('NOT');
      if (this.eatKw('NULL')) return (row) => (left.get(row).t === 'null') !== neg;
      if (this.isKw('TRUE') || this.isKw('FALSE')) {
        const want = this.isKw('TRUE');
        this.i++;
        return (row) => {
          const v = left.get(row);
          const n = v.t === 'null' ? null : toNum(v);
          const is = n !== null && n !== 0 === want;
          return is !== neg;
        };
      }
      if (this.eatKw('DISTINCT')) {
        this.expectKw('FROM');
        const right = this.parseExpr();
        return (row) => {
          const a = left.get(row);
          const b = right.get(row);
          const same = a.t === 'null' || b.t === 'null' ? a.t === b.t : compareValues(a, b, this.ci) === 0;
          return same === neg;
        };
      }
      this.fail();
    }
    let neg = false;
    if (this.isKw('NOT') && (this.isKw('LIKE', 1) || this.isKw('ILIKE', 1) || this.isKw('IN', 1) || this.isKw('BETWEEN', 1))) {
      this.i++;
      neg = true;
    }
    if (this.isKw('LIKE') || this.isKw('ILIKE')) {
      const ci = this.isKw('ILIKE') || this.ci;
      this.i++;
      const pattern = this.parseExpr();
      const cache = new Map<string, RegExp>();
      return (row) => {
        const v = left.get(row);
        const p = pattern.get(row);
        if (v.t === 'null' || p.t === 'null') return null;
        const ps = toStr(p);
        let re = cache.get(ps);
        if (!re) {
          re = likeRegex(ps, ci);
          cache.set(ps, re);
        }
        return re.test(toStr(v)) !== neg;
      };
    }
    if (this.eatKw('IN')) {
      this.expect('lp');
      if (this.isKw('SELECT')) throw new SqlError('subqueries are not supported by the mock backend', '0A000', this.peek()!.pos);
      const list = [this.parseExpr()];
      while (this.peek()?.k === 'comma') {
        this.i++;
        list.push(this.parseExpr());
      }
      this.expect('rp');
      return (row) => {
        const v = left.get(row);
        if (v.t === 'null') return null;
        let sawNull = false;
        for (const e of list) {
          const x = e.get(row);
          if (x.t === 'null') sawNull = true;
          else if (compareValues(v, x, this.ci) === 0) return !neg;
        }
        return sawNull ? null : neg;
      };
    }
    if (this.eatKw('BETWEEN')) {
      const lo = this.parseExpr();
      this.expectKw('AND');
      const hi = this.parseExpr();
      return (row) => {
        const v = left.get(row);
        const a = compareValues(v, lo.get(row), this.ci);
        const b = compareValues(v, hi.get(row), this.ci);
        if (a === null || b === null) return null;
        return (a >= 0 && b <= 0) !== neg;
      };
    }
    const op = this.peek();
    if (op && op.k === 'op' && CMP_OPS.has(op.v)) {
      this.i++;
      const right = this.parseExpr();
      const test = cmpFn(op.v);
      return (row) => {
        const r = compareValues(left.get(row), right.get(row), this.ci);
        return r === null ? null : test(r);
      };
    }
    if (neg) this.fail();
    // Bare operand used as a boolean (e.g. `is_active`).
    return (row) => {
      const v = left.get(row);
      if (v.t === 'null') return null;
      if (v.t === 'text') {
        const b = toBoolNum(v.v);
        if (b === null) throw new SqlError(`argument of WHERE must be type boolean, not type text`, '42804');
        return b === 1;
      }
      return (toNum(v) ?? 0) !== 0;
    };
  }

  // -- scalar expressions ------------------------------------------------

  parseExpr(): Expr {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== 'op' || (t.v !== '+' && t.v !== '-' && t.v !== '||')) return left;
      this.i++;
      const right = this.parseTerm();
      left = arith(t.v, left, right, this.env.kind);
    }
  }

  private parseTerm(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const op = t?.k === 'star' ? '*' : t?.k === 'op' && (t.v === '/' || t.v === '%') ? t.v : null;
      if (!op) return left;
      this.i++;
      const right = this.parseUnary();
      left = arith(op, left, right, this.env.kind);
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t?.k === 'op' && (t.v === '-' || t.v === '+')) {
      this.i++;
      const e = this.parseUnary();
      if (t.v === '+') return e;
      return {
        ...e,
        name: '?column?',
        colIndex: undefined,
        get: (row) => {
          const v = e.get(row);
          if (v.t === 'int') return vInt(v.v.startsWith('-') ? v.v.slice(1) : `-${v.v}`);
          if (v.t === 'decimal') return vDec(v.v.startsWith('-') ? v.v.slice(1) : `-${v.v}`);
          if (v.t === 'float') return vFloat(-v.v);
          return v;
        }
      };
    }
    let e = this.parsePrimary();
    // Postfix casts: expr::type
    while (this.peek()?.k === 'op' && this.peek()!.v === '::') {
      this.i++;
      const typeTok = this.expect('id');
      let type = typeTok.v;
      while (this.peek()?.k === 'dot') {
        this.i++;
        type += `.${this.expect('id').v}`;
      }
      if (this.peek()?.k === 'lp') this.skipParens();
      e = castExpr(e, type, this.env.kind);
    }
    return e;
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const t = this.peek();
      if (!t) this.fail();
      if (t.k === 'lp') depth++;
      else if (t.k === 'rp') depth--;
      this.i++;
    } while (depth > 0);
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (!t) this.fail();
    const { kind } = this.env;
    if (t.k === 'lp') {
      if (this.isKw('SELECT', 1)) throw new SqlError('subqueries are not supported by the mock backend', '0A000', t.pos);
      this.i++;
      const e = this.parseExpr();
      this.expect('rp');
      return e;
    }
    if (t.k === 'str') {
      this.i++;
      const v = vText(t.v);
      return { get: () => v, type: kind === 'postgres' ? 'unknown' : typeName(kind, 'text'), name: '?column?' };
    }
    if (t.k === 'num') {
      this.i++;
      const isInt = /^\d+$/.test(t.v);
      const v = isInt ? vInt(t.v) : vDec(t.v);
      return { get: () => v, type: typeName(kind, isInt ? 'int' : 'numeric'), name: '?column?' };
    }
    if (t.k !== 'id' && t.k !== 'qid') this.fail();
    const upper = t.k === 'id' ? t.v.toUpperCase() : '';
    const nextIsLp = this.peek(1)?.k === 'lp';
    if (t.k === 'id' && !nextIsLp) {
      const lit = this.keywordConstant(upper);
      if (lit) {
        this.i++;
        return lit;
      }
    }
    if (upper === 'CASE') return this.parseCase();
    if (upper === 'CAST' && nextIsLp) {
      this.i += 2;
      const inner = this.parseExpr();
      this.expectKw('AS');
      let type = '';
      let depth = 0;
      while (this.peek() && !(this.peek()!.k === 'rp' && depth === 0)) {
        const x = this.peek()!;
        if (x.k === 'lp') depth++;
        if (x.k === 'rp') depth--;
        type += x.v;
        this.i++;
      }
      this.expect('rp');
      return { ...castExpr(inner, type, kind), name: inner.name };
    }
    if (t.k === 'id' && nextIsLp) {
      if (AGGREGATES.has(upper)) throw new SqlError(`aggregate functions are not allowed here`, '42803', t.pos);
      this.i += 2;
      const args: Expr[] = [];
      if (this.peek()?.k !== 'rp') {
        args.push(this.parseExpr());
        while (this.peek()?.k === 'comma') {
          this.i++;
          args.push(this.parseExpr());
        }
      }
      this.expect('rp');
      return callFunction(t, args, this.env);
    }
    // Column reference, possibly qualified.
    this.i++;
    const parts = [t.v];
    while (this.peek()?.k === 'dot' && (this.peek(1)?.k === 'id' || this.peek(1)?.k === 'qid')) {
      parts.push(this.peek(1)!.v);
      this.i += 2;
    }
    const name = parts[parts.length - 1];
    const idx = findColumn(this.cols, name);
    if (idx < 0) {
      if (t.k === 'qid' && t.q === '"' && kind === 'mysql' && parts.length === 1) {
        // MySQL treats "double quoted" text as a string literal.
        const v = vText(t.v);
        return { get: () => v, type: 'varchar', name: t.v };
      }
      throw new SqlError(`column "${parts.join('.')}" does not exist`, '42703', t.pos);
    }
    const col = this.cols[idx];
    return { get: (row) => row[idx] ?? NUL, type: col.type, name: col.name, colIndex: idx };
  }

  private keywordConstant(upper: string): Expr | null {
    const { kind } = this.env;
    const c = (v: Value, type: string, name: string): Expr => ({ get: () => v, type, name });
    switch (upper) {
      case 'NULL':
        return c(NUL, kind === 'postgres' ? 'unknown' : typeName(kind, 'text'), '?column?');
      case 'TRUE':
      case 'FALSE':
        return c(kind === 'sqlite' || kind === 'mysql' ? vInt(upper === 'TRUE' ? 1 : 0) : vBool(upper === 'TRUE'), typeName(kind, 'bool'), kind === 'postgres' ? 'bool' : '?column?');
      case 'CURRENT_TIMESTAMP':
      case 'LOCALTIMESTAMP':
        return { get: () => vDate(nowText(kind)), type: typeName(kind, 'timestamp'), name: upper.toLowerCase() };
      case 'CURRENT_DATE':
        return { get: () => vDate(new Date().toISOString().slice(0, 10)), type: 'date', name: 'current_date' };
      case 'CURRENT_USER':
      case 'SESSION_USER':
      case 'USER':
        return c(vText(this.env.user), 'name', upper.toLowerCase());
      case '@@VERSION':
        return c(vText(fullVersion(this.env)), 'nvarchar', '');
      case '@@SERVERNAME':
        return c(vText('SQL-PROD-01'), 'nvarchar', '');
      case '@@ROWCOUNT':
        return c(vInt(0), 'int', '');
      default:
        return null;
    }
  }

  private parseCase(): Expr {
    this.i++;
    let subject: Expr | null = null;
    if (!this.isKw('WHEN')) subject = this.parseExpr();
    const arms: { when: Pred; then: Expr }[] = [];
    while (this.eatKw('WHEN')) {
      let when: Pred;
      if (subject) {
        const s = subject;
        const v = this.parseExpr();
        when = (row) => compareValues(s.get(row), v.get(row), this.ci) === 0;
      } else when = this.parseCondition();
      this.expectKw('THEN');
      arms.push({ when, then: this.parseExpr() });
    }
    const otherwise = this.eatKw('ELSE') ? this.parseExpr() : null;
    this.expectKw('END');
    return {
      get: (row) => {
        for (const a of arms) if (a.when(row) === true) return a.then.get(row);
        return otherwise ? otherwise.get(row) : NUL;
      },
      type: arms[0]?.then.type ?? 'text',
      name: 'case'
    };
  }
}

function cmpFn(op: string): (r: number) => boolean {
  switch (op) {
    case '=':
      return (r) => r === 0;
    case '<>':
    case '!=':
      return (r) => r !== 0;
    case '<':
      return (r) => r < 0;
    case '>':
      return (r) => r > 0;
    case '<=':
      return (r) => r <= 0;
    default:
      return (r) => r >= 0;
  }
}

function likeRegex(pattern: string, ci: boolean): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '');
}

function findColumn(cols: ColumnRef[], name: string): number {
  const exact = cols.findIndex((c) => c.name === name);
  if (exact >= 0) return exact;
  const lower = name.toLowerCase();
  return cols.findIndex((c) => c.name.toLowerCase() === lower);
}

function decimals(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

function arith(op: string, a: Expr, b: Expr, kind: DbKind): Expr {
  const isConcat = op === '||' && kind !== 'mysql';
  return {
    name: '?column?',
    type: isConcat ? typeName(kind, 'text') : a.type,
    get: (row) => {
      const x = a.get(row);
      const y = b.get(row);
      if (x.t === 'null' || y.t === 'null') return NUL;
      if (isConcat || (op === '+' && kind === 'mssql' && (x.t === 'text' || y.t === 'text'))) return vText(toStr(x) + toStr(y));
      const nx = toNum(x);
      const ny = toNum(y);
      if (nx === null || ny === null) throw new SqlError(`operator does not exist: ${a.type} ${op} ${b.type}`, '42883');
      let r: number;
      switch (op) {
        case '+':
          r = nx + ny;
          break;
        case '-':
          r = nx - ny;
          break;
        case '*':
          r = nx * ny;
          break;
        case '/':
          if (ny === 0) throw new SqlError('division by zero', '22012');
          r = x.t === 'int' && y.t === 'int' && kind !== 'mysql' ? Math.trunc(nx / ny) : nx / ny;
          break;
        default:
          r = nx % ny;
      }
      if (x.t === 'int' && y.t === 'int' && Number.isInteger(r)) return vInt(r);
      if (x.t === 'float' || y.t === 'float') return vFloat(r);
      const scale = op === '*' ? decimals(toStr(x)) + decimals(toStr(y)) : op === '/' ? 6 : Math.max(decimals(toStr(x)), decimals(toStr(y)));
      return vDec(r.toFixed(Math.min(scale, 10)));
    }
  };
}

function castExpr(e: Expr, type: string, kind: DbKind): Expr {
  const t = type.trim();
  const col: MockColumn = { name: e.name, type: t, nullable: true, defaultValue: null, isIdentity: false };
  return {
    name: e.name,
    type: t,
    colIndex: undefined,
    get: (row) => {
      const v = e.get(row);
      if (v.t === 'null') return v;
      const cls = classifyType(t);
      if (cls === 'datetime' && /^date$/i.test(t)) return vDate(toStr(v).slice(0, 10));
      if (cls === 'text') return vText(textOf(v));
      if (cls === 'int' && (v.t === 'decimal' || v.t === 'float')) return vInt(Math.round(toNum(v) ?? 0));
      return coerceTo(v, col, kind);
    }
  };
}

function fullVersion(env: Env): string {
  switch (env.kind) {
    case 'postgres':
      return `${env.version} on aarch64-apple-darwin24.2.0, compiled by Apple clang version 16.0.0 (clang-1600.0.26.6), 64-bit`;
    case 'mssql':
      return `${env.version} (X64) \n\tAug  1 2024 12:44:22 \n\tCopyright (C) 2022 Microsoft Corporation\n\tEnterprise Edition: Core-based Licensing (64-bit) on Linux (Ubuntu 22.04.4 LTS) <X64>`;
    default:
      return env.version.replace(/^\D+/, '');
  }
}

function callFunction(t: Tok, args: Expr[], env: Env): Expr {
  const name = t.v.toLowerCase();
  const { kind } = env;
  const a0 = args[0];
  const unary = (type: string, f: (v: Value) => Value): Expr => {
    if (!a0) throw new SqlError(`function ${name}() does not exist`, '42883', t.pos);
    return { name, type, get: (row) => { const v = a0.get(row); return v.t === 'null' ? v : f(v); } };
  };
  const constant = (v: () => Value, type: string): Expr => ({ name, type, get: v });
  switch (name) {
    case 'lower':
    case 'lcase':
      return unary(a0?.type ?? 'text', (v) => vText(toStr(v).toLowerCase()));
    case 'upper':
    case 'ucase':
      return unary(a0?.type ?? 'text', (v) => vText(toStr(v).toUpperCase()));
    case 'length':
    case 'len':
    case 'char_length':
      return unary(typeName(kind, 'int'), (v) => vInt(toStr(v).length));
    case 'trim':
    case 'ltrim':
    case 'rtrim':
      return unary('text', (v) => vText(name === 'ltrim' ? toStr(v).trimStart() : name === 'rtrim' ? toStr(v).trimEnd() : toStr(v).trim()));
    case 'abs':
      return unary(a0?.type ?? 'numeric', (v) => (v.t === 'int' ? vInt(v.v.replace('-', '')) : v.t === 'decimal' ? vDec(v.v.replace('-', '')) : vFloat(Math.abs(toNum(v) ?? 0))));
    case 'round':
    case 'floor':
    case 'ceil':
    case 'ceiling': {
      const places = args[1];
      return {
        name,
        type: a0?.type ?? 'numeric',
        get: (row) => {
          const v = a0?.get(row) ?? NUL;
          if (v.t === 'null') return v;
          const n = toNum(v) ?? 0;
          const p = places ? Number(toNum(places.get(row)) ?? 0) : 0;
          const f = 10 ** p;
          const r = name === 'round' ? Math.round(n * f) / f : name === 'floor' ? Math.floor(n) : Math.ceil(n);
          return v.t === 'float' ? vFloat(r) : p > 0 ? vDec(r.toFixed(p)) : vDec(String(r));
        }
      };
    }
    case 'coalesce':
    case 'ifnull':
    case 'isnull':
    case 'nvl':
      return { name: 'coalesce', type: a0?.type ?? 'text', get: (row) => args.map((e) => e.get(row)).find((v) => v.t !== 'null') ?? NUL };
    case 'nullif':
      return {
        name,
        type: a0?.type ?? 'text',
        get: (row) => {
          const x = a0?.get(row) ?? NUL;
          const y = args[1]?.get(row) ?? NUL;
          return compareValues(x, y) === 0 ? NUL : x;
        }
      };
    case 'concat':
      return { name, type: typeName(kind, 'text'), get: (row) => vText(args.map((e) => textOf(e.get(row))).join('')) };
    case 'substring':
    case 'substr': {
      return {
        name,
        type: 'text',
        get: (row) => {
          const v = a0?.get(row) ?? NUL;
          if (v.t === 'null') return v;
          const from = Number(toNum(args[1]?.get(row) ?? vInt(1)) ?? 1);
          const len = args[2] ? Number(toNum(args[2].get(row)) ?? 0) : undefined;
          const s = toStr(v);
          return vText(len === undefined ? s.slice(from - 1) : s.slice(from - 1, from - 1 + len));
        }
      };
    }
    case 'date':
      return unary('date', (v) => vDate(toStr(v).slice(0, 10)));
    case 'now':
    case 'getdate':
    case 'sysdatetime':
    case 'getutcdate':
    case 'sysutcdatetime':
    case 'current_timestamp':
    case 'statement_timestamp':
    case 'clock_timestamp':
    case 'transaction_timestamp':
      return constant(() => vDate(nowText(kind)), typeName(kind, 'timestamp'));
    case 'version':
    case 'sqlite_version':
      return constant(() => vText(kind === 'sqlite' ? '3.50.4' : fullVersion(env)), typeName(kind, 'text'));
    case 'current_database':
    case 'db_name':
    case 'database':
    case 'schema':
      return constant(() => vText(env.database), 'name');
    case 'current_schema':
    case 'schema_name':
      return constant(() => vText(env.db.defaultSchema), 'name');
    case 'suser_name':
    case 'suser_sname':
    case 'user_name':
    case 'current_user':
    case 'user':
      return constant(() => vText(env.user), 'name');
    case 'random':
    case 'rand': {
      return constant(() => vFloat(Math.random()), typeName(kind, 'float'));
    }
    case 'gen_random_uuid':
    case 'newid':
    case 'uuid':
      return constant(() => vText(crypto.randomUUID()), kind === 'mssql' ? 'uniqueidentifier' : 'uuid');
    case 'pg_backend_pid':
    case 'connection_id':
      return constant(() => vInt(48213), typeName(kind, 'int'));
    default:
      throw new SqlError(`function ${t.v}(${args.map((x) => x.type).join(', ')}) does not exist`, '42883', t.pos, 'No function matches the given name and argument types.');
  }
}

/** Compile a WHERE body against a column list. Throws SqlError on bad syntax or unknown columns. */
export function compileWhere(where: string, cols: ColumnRef[], env: Env, base = 0): (row: Value[]) => boolean {
  const toks = tokenize(where, base);
  if (toks.length === 0) return () => true;
  const p = new ExprParser(toks, cols, env, base + where.length);
  const pred = p.parseCondition();
  if (!p.atEnd()) p.fail();
  return (row) => pred(row) === true;
}

// ---------------------------------------------------------------------------
// Clause scanning
// ---------------------------------------------------------------------------

const CLAUSE_WORDS = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'FOR', 'INTO', 'RETURNING']);

interface Clause {
  kw: string;
  start: number;
  body: number;
  end: number;
}

function skipQuoted(sql: string, i: number): number {
  const open = sql[i];
  const close = open === '[' ? ']' : open;
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === close) {
      if (sql[j + 1] === close && open !== '[') {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return sql.length;
}

/** Top-level clause keywords (outside parentheses, quotes, and comments). */
function scanClauses(sql: string): Clause[] {
  const out: Clause[] = [];
  const n = sql.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      i = skipQuoted(sql, i);
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[\w$.@#]/.test(sql[i - 1]))) {
      let j = i;
      while (j < n && /[\w$#@]/.test(sql[j])) j++;
      const word = sql.slice(i, j).toUpperCase();
      if (depth === 0 && CLAUSE_WORDS.has(word)) {
        let body = j;
        let kw = word;
        if (word === 'GROUP' || word === 'ORDER') {
          const m = /^\s+BY\b/i.exec(sql.slice(j));
          if (!m) {
            i = j;
            continue;
          }
          body = j + m[0].length;
          kw = `${word} BY`;
        }
        out.push({ kw, start: i, body, end: n });
      }
      i = j;
      continue;
    }
    i++;
  }
  for (let k = 0; k < out.length; k++) out[k].end = k + 1 < out.length ? out[k + 1].start : n;
  return out;
}

/** Split on top-level commas, keeping absolute offsets. */
function splitTopLevel(sql: string, from: number, to: number): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = [];
  let depth = 0;
  let start = from;
  let i = from;
  while (i < to) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      i = skipQuoted(sql, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push({ text: sql.slice(start, i), start });
      start = i + 1;
    }
    i++;
  }
  parts.push({ text: sql.slice(start, to), start });
  return parts.filter((p) => p.text.trim() !== '');
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

interface Source {
  columns: ColumnRef[];
  rows: Value[][];
  table?: MockTable;
}

type Item =
  | { k: 'star'; raw: string }
  | { k: 'expr'; e: Expr; name: string; raw: string; aliased: boolean }
  | { k: 'agg'; fn: string; distinct: boolean; arg: Expr | null; name: string; raw: string };

interface SelectResult {
  columns: ResultColumn[];
  rows: Value[][];
  editable?: EditableTarget;
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function stripAlias(toks: Tok[]): { expr: Tok[]; alias: string | null } {
  const n = toks.length;
  if (n >= 3 && isWord(toks[n - 2], 'AS') && (toks[n - 1].k === 'id' || toks[n - 1].k === 'qid' || toks[n - 1].k === 'str'))
    return { expr: toks.slice(0, n - 2), alias: toks[n - 1].v };
  if (n >= 2) {
    const last = toks[n - 1];
    const prev = toks[n - 2];
    const aliasable = last.k === 'qid' || (last.k === 'id' && !NOT_ALIAS.has(last.v.toUpperCase()));
    const prevOk = prev.k === 'id' || prev.k === 'qid' || prev.k === 'rp' || prev.k === 'str' || prev.k === 'num' || prev.k === 'star';
    if (aliasable && prevOk && !(prev.k === 'id' && prev.v.toUpperCase() === 'CASE')) return { expr: toks.slice(0, n - 1), alias: last.v };
  }
  return { expr: toks, alias: null };
}

/** Find the token index of the paren matching toks[open]. */
function matchParen(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    if (toks[i].k === 'lp') depth++;
    else if (toks[i].k === 'rp' && --depth === 0) return i;
  }
  return -1;
}

interface Ctx {
  env: Env;
  ctes: Map<string, () => Source>;
}

function parseCtes(sql: string, ctx: Ctx): number {
  // Returns the offset where the main statement starts.
  const toks = tokenize(sql);
  let i = 0;
  if (!isWord(toks[i], 'WITH')) return 0;
  i++;
  if (isWord(toks[i], 'RECURSIVE')) i++;
  for (;;) {
    const nameTok = toks[i];
    if (!nameTok || (nameTok.k !== 'id' && nameTok.k !== 'qid')) throw new SqlError(`syntax error at or near "${nameTok?.v ?? ''}"`, '42601', nameTok?.pos);
    i++;
    if (toks[i]?.k === 'lp') i = matchParen(toks, i) + 1;
    if (!isWord(toks[i], 'AS')) throw new SqlError(`syntax error at or near "${toks[i]?.v ?? ''}"`, '42601', toks[i]?.pos);
    i++;
    if (isWord(toks[i], 'MATERIALIZED')) i++;
    if (isWord(toks[i], 'NOT') && isWord(toks[i + 1], 'MATERIALIZED')) i += 2;
    if (toks[i]?.k !== 'lp') throw new SqlError(`syntax error at or near "${toks[i]?.v ?? ''}"`, '42601', toks[i]?.pos);
    const close = matchParen(toks, i);
    if (close < 0) throw new SqlError('syntax error at end of input', '42601', sql.length);
    const bodyStart = toks[i].end;
    const bodyEnd = toks[close].pos;
    let cached: Source | null = null;
    const body = sql.slice(bodyStart, bodyEnd);
    ctx.ctes.set(nameTok.v.toLowerCase(), () => {
      if (!cached) {
        const r = execSelectText(body, ctx);
        cached = { columns: r.columns.map((c) => ({ name: c.name, type: c.type })), rows: r.rows };
      }
      return cached;
    });
    i = close + 1;
    if (toks[i]?.k === 'comma') {
      i++;
      continue;
    }
    return toks[i]?.pos ?? sql.length;
  }
}

function execSelectText(sql: string, ctx: Ctx): SelectResult {
  const start = parseCtes(sql, ctx);
  // Offsets stay absolute: blank out the WITH prefix instead of slicing it off.
  return execSelect(start > 0 ? ' '.repeat(start) + sql.slice(start) : sql, ctx);
}

function resolveSource(sql: string, fromBody: number, fromEnd: number, ctx: Ctx): { src: Source; join: boolean } {
  const toks = tokenize(sql.slice(fromBody, fromEnd), fromBody);
  if (toks.length === 0) throw new SqlError('syntax error at end of input', '42601', fromEnd);
  let i = 0;
  let src: Source;
  if (toks[0].k === 'lp') {
    const close = matchParen(toks, 0);
    if (close < 0) throw new SqlError('syntax error at end of input', '42601', fromEnd);
    const inner = execSelectText(' '.repeat(toks[0].end) + sql.slice(toks[0].end, toks[close].pos), ctx);
    src = { columns: inner.columns.map((c) => ({ name: c.name, type: c.type })), rows: inner.rows };
    i = close + 1;
  } else {
    const first = toks[0];
    if (first.k !== 'id' && first.k !== 'qid') throw new SqlError(`syntax error at or near "${first.v}"`, '42601', first.pos);
    const parts = [first.v];
    i = 1;
    while (toks[i]?.k === 'dot' && (toks[i + 1]?.k === 'id' || toks[i + 1]?.k === 'qid')) {
      parts.push(toks[i + 1].v);
      i += 2;
    }
    if (toks[i]?.k === 'lp' && parts.length === 1 && first.v.toLowerCase() === 'generate_series') {
      const close = matchParen(toks, i);
      const nums = toks.slice(i + 1, close).filter((t) => t.k === 'num').map((t) => Number(t.v));
      const [lo = 1, hi = 10, step = 1] = nums;
      const rows: Value[][] = [];
      for (let x = lo; step > 0 ? x <= hi : x >= hi; x += step) {
        rows.push([vInt(x)]);
        if (rows.length > 1_000_000) break;
      }
      src = { columns: [{ name: 'generate_series', type: 'int4' }], rows };
      i = close + 1;
    } else {
      const name = parts[parts.length - 1];
      const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
      const cte = !schema ? ctx.ctes.get(name.toLowerCase()) : undefined;
      if (cte) src = cte();
      else {
        const t = resolveTable(ctx.env.db, schema, name);
        if (!t) {
          throw new SqlError(
            ctx.env.kind === 'mssql' ? `Invalid object name '${parts.join('.')}'.` : `relation "${parts.join('.')}" does not exist`,
            ctx.env.kind === 'mssql' ? '208' : '42P01',
            first.pos
          );
        }
        src = { columns: t.columns.map((c) => ({ name: c.name, type: c.type })), rows: rowsOf(ctx.env.db, t), table: t };
      }
    }
  }
  const join = toks.slice(i).some((t) => t.k === 'comma' || isWord(t, 'JOIN') || isWord(t, 'APPLY'));
  return { src, join };
}

function execSelect(sql: string, ctx: Ctx): SelectResult {
  const { env } = ctx;
  let clauses = scanClauses(sql);
  const setOp = clauses.find((c) => c.kw === 'UNION' || c.kw === 'EXCEPT' || c.kw === 'INTERSECT');
  if (setOp) {
    clauses = clauses.filter((c) => c.start < setOp.start);
    if (clauses.length) clauses[clauses.length - 1].end = setOp.start;
  }
  const get = (kw: string) => clauses.find((c) => c.kw === kw);
  const sel = get('SELECT');
  if (!sel) {
    const first = tokenize(sql)[0];
    throw new SqlError(`syntax error at or near "${first?.v ?? ''}"`, '42601', first?.pos ?? 0);
  }

  // Prefix: ALL / DISTINCT / TOP n
  const selText = sql.slice(sel.body, sel.end);
  const prefix = /^\s*(ALL\s+|DISTINCT\s+(?:ON\s*\([^)]*\)\s*)?)?(?:TOP\s*\(?\s*(\d+)\s*\)?\s*(?:PERCENT\s+)?(?:WITH\s+TIES\s+)?)?/i.exec(selText)!;
  const distinct = /^distinct/i.test(prefix[1] ?? '');
  const top = prefix[2] !== undefined ? Number(prefix[2]) : null;
  const itemsStart = sel.body + prefix[0].length;

  const from = get('FROM');
  const into = get('INTO');
  const projEnd = into && into.start < (from?.start ?? Infinity) ? into.start : sel.end;
  let src: Source = { columns: [], rows: [[]] };
  let join = false;
  if (from) ({ src, join } = resolveSource(sql, from.body, from.end, ctx));

  // WHERE
  let rows = src.rows;
  const where = get('WHERE');
  if (where) {
    try {
      const pred = compileWhere(sql.slice(where.body, where.end), src.columns, env, where.body);
      rows = rows.filter(pred);
    } catch (err) {
      if (!(join && err instanceof SqlError && err.code === '42703')) throw err;
    }
  }

  // Projection
  let fallback = false;
  const items: Item[] = [];
  for (const part of splitTopLevel(sql, itemsStart, projEnd)) {
    const raw = part.text.trim();
    const toks = tokenize(part.text, part.start);
    if (toks.length === 1 && toks[0].k === 'star') {
      items.push({ k: 'star', raw });
      continue;
    }
    if (toks.length === 3 && toks[1].k === 'dot' && toks[2].k === 'star') {
      items.push({ k: 'star', raw });
      continue;
    }
    const { expr, alias } = stripAlias(toks);
    const head = expr[0];
    if (head && head.k === 'id' && AGGREGATES.has(head.v.toUpperCase()) && expr[1]?.k === 'lp' && matchParen(expr, 1) === expr.length - 1) {
      const fn = head.v.toUpperCase();
      let inner = expr.slice(2, -1);
      const isDistinct = isWord(inner[0], 'DISTINCT');
      if (isDistinct) inner = inner.slice(1);
      let arg: Expr | null = null;
      if (!(inner.length === 1 && inner[0].k === 'star')) {
        if (inner.length === 0) throw new SqlError(`function ${fn.toLowerCase()}() does not exist`, '42883', head.pos);
        try {
          const p = new ExprParser(inner, src.columns, env, inner[inner.length - 1].end);
          arg = p.parseExpr();
          if (!p.atEnd()) p.fail();
        } catch (err) {
          if (err instanceof SqlError && err.code === '42703' && !join) throw err;
          fallback = true;
          break;
        }
      }
      items.push({ k: 'agg', fn, distinct: isDistinct, arg, name: alias ?? fn.toLowerCase(), raw: norm(expr.map((t) => t.v).join('')) });
      continue;
    }
    try {
      if (expr.length === 0) throw new SqlError('syntax error', '42601', part.start);
      const p = new ExprParser(expr, src.columns, env, expr[expr.length - 1].end);
      const e = p.parseExpr();
      if (!p.atEnd()) p.fail();
      items.push({ k: 'expr', e, name: alias ?? e.name, raw: norm(expr.map((t) => t.v).join('')), aliased: alias !== null && alias !== e.name });
    } catch (err) {
      if (err instanceof SqlError && err.code === '42703' && !join) throw err;
      fallback = true;
      break;
    }
  }
  if (fallback || items.length === 0) {
    items.length = 0;
    items.push({ k: 'star', raw: '*' });
  }

  const groupBy = get('GROUP BY');
  const aggMode = items.some((it) => it.k === 'agg') || !!groupBy;
  const columns: ResultColumn[] = [];
  for (const it of items) {
    if (it.k === 'star') columns.push(...src.columns.map((c) => ({ name: c.name, type: c.type })));
    else if (it.k === 'expr') columns.push({ name: it.name, type: it.e.type });
    else columns.push({ name: it.name, type: aggType(it, env.kind) });
  }

  let out: Value[][];
  if (aggMode) {
    const keyExprs: Expr[] = [];
    if (groupBy) {
      for (const part of splitTopLevel(sql, groupBy.body, groupBy.end)) {
        const toks = tokenize(part.text, part.start);
        if (toks.length === 1 && toks[0].k === 'num') {
          const it = items[Number(toks[0].v) - 1];
          if (it && it.k === 'expr') keyExprs.push(it.e);
          continue;
        }
        const aliasItem = toks.length === 1 ? items.find((it) => it.k === 'expr' && it.name.toLowerCase() === toks[0].v.toLowerCase()) : undefined;
        if (aliasItem && aliasItem.k === 'expr') {
          keyExprs.push(aliasItem.e);
          continue;
        }
        try {
          const p = new ExprParser(toks, src.columns, env, part.start + part.text.length);
          keyExprs.push(p.parseExpr());
        } catch (err) {
          if (!join) throw err;
        }
      }
    }
    const groups = new Map<string, Value[][]>();
    for (const r of rows) {
      const key = JSON.stringify(keyExprs.map((e) => e.get(r)));
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    if (!groupBy && groups.size === 0) groups.set('[]', []);
    out = [];
    for (const g of groups.values()) {
      const row: Value[] = [];
      for (const it of items) {
        if (it.k === 'star') row.push(...(g[0] ?? src.columns.map(() => NUL)));
        else if (it.k === 'expr') row.push(g[0] ? it.e.get(g[0]) : NUL);
        else row.push(aggregate(it, g, env.kind));
      }
      out.push(row);
    }
    const order = get('ORDER BY');
    if (order) {
      const keys = orderKeys(sql, order, items, columns, null, env);
      out.sort((a, b) => compareRows(keys, { src: a, out: a }, { src: b, out: b }));
    }
  } else {
    const project = (r: Value[]): Value[] => {
      const row: Value[] = [];
      for (const it of items) {
        if (it.k === 'star') row.push(...r);
        else if (it.k === 'expr') row.push(it.e.get(r));
      }
      return row;
    };
    let pairs = rows.map((r) => ({ src: r, out: project(r) }));
    const order = get('ORDER BY');
    if (order) {
      const keys = orderKeys(sql, order, items, columns, src.columns, env);
      pairs = [...pairs].sort((a, b) => compareRows(keys, a, b));
    }
    out = pairs.map((p) => p.out);
  }

  if (distinct) {
    const seen = new Set<string>();
    out = out.filter((r) => {
      const k = JSON.stringify(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // OFFSET / LIMIT / FETCH / TOP
  let offset = 0;
  let limit: number | null = top;
  const lim = get('LIMIT');
  if (lim) {
    const m = /^\s*(\d+|ALL)\s*(?:(?:,\s*(\d+))|(?:OFFSET\s+(\d+)))?\s*$/i.exec(sql.slice(lim.body, lim.end));
    if (!m) throw new SqlError(`syntax error at or near "${sql.slice(lim.body, lim.end).trim().split(/\s+/)[0] ?? ''}"`, '42601', lim.body);
    if (m[2] !== undefined) {
      offset = Number(m[1]);
      limit = Number(m[2]);
    } else {
      limit = /^all$/i.test(m[1]) ? null : Number(m[1]);
      if (m[3] !== undefined) offset = Number(m[3]);
    }
  }
  const off = get('OFFSET');
  if (off) {
    const m = /^\s*(\d+)/.exec(sql.slice(off.body, off.end));
    if (m) offset = Number(m[1]);
  }
  const fetch = get('FETCH');
  if (fetch) {
    const m = /^\s*(?:FIRST|NEXT)\s+(\d+)?/i.exec(sql.slice(fetch.body, fetch.end));
    if (m) limit = m[1] ? Number(m[1]) : 1;
  }
  if (offset || limit !== null) out = out.slice(offset, limit === null ? undefined : offset + limit);

  // Editable when the result maps 1:1 onto one base table with a primary key.
  let editable: EditableTarget | undefined;
  const t = src.table;
  if (t && t.kind === 'table' && t.primaryKey.length > 0 && !join && !aggMode && !distinct && !fallback && !setOp) {
    const plain = items.every((it) => it.k === 'star' || (it.k === 'expr' && it.e.colIndex !== undefined && !it.aliased));
    const names = new Set(columns.map((c) => c.name.toLowerCase()));
    if (plain && t.primaryKey.every((k) => names.has(k.toLowerCase()))) editable = { schema: t.schema, table: t.name, primaryKey: [...t.primaryKey] };
  }
  return { columns, rows: out, editable };
}

interface OrderKey {
  side: 'src' | 'out';
  get: (row: Value[]) => Value;
  desc: boolean;
  nullsFirst: boolean;
}

function orderKeys(sql: string, order: Clause, items: Item[], columns: ResultColumn[], srcCols: ColumnRef[] | null, env: Env): OrderKey[] {
  const keys: OrderKey[] = [];
  for (const part of splitTopLevel(sql, order.body, order.end)) {
    let toks = tokenize(part.text, part.start);
    let desc = false;
    let nullsFirst: boolean | null = null;
    if (toks.length >= 2 && isWord(toks[toks.length - 2], 'NULLS')) {
      nullsFirst = isWord(toks[toks.length - 1], 'FIRST');
      toks = toks.slice(0, -2);
    }
    if (isWord(toks[toks.length - 1], 'DESC') || isWord(toks[toks.length - 1], 'ASC')) {
      desc = isWord(toks[toks.length - 1], 'DESC');
      toks = toks.slice(0, -1);
    }
    const nf = nullsFirst ?? (env.kind === 'postgres' ? desc : !desc);
    if (toks.length === 1 && toks[0].k === 'num') {
      const idx = Number(toks[0].v) - 1;
      if (idx < 0 || idx >= columns.length) throw new SqlError(`ORDER BY position ${idx + 1} is not in select list`, '42P10', toks[0].pos);
      keys.push({ side: 'out', get: (r) => r[idx] ?? NUL, desc, nullsFirst: nf });
      continue;
    }
    const raw = norm(toks.map((t) => t.v).join(''));
    const single = toks.length === 1 || (toks.length === 3 && toks[1].k === 'dot') ? toks[toks.length - 1].v.toLowerCase() : null;
    const outIdx = columns.findIndex((c, i) => {
      if (single && c.name.toLowerCase() === single) return true;
      const it = itemAtColumn(items, columns, i, srcCols);
      return !!it && it.k !== 'star' && it.raw === raw;
    });
    if (outIdx >= 0 && (srcCols === null || !single || !srcCols.some((c) => c.name.toLowerCase() === single) || columns[outIdx].name.toLowerCase() === single)) {
      keys.push({ side: 'out', get: (r) => r[outIdx] ?? NUL, desc, nullsFirst: nf });
      continue;
    }
    if (srcCols) {
      const p = new ExprParser(toks, srcCols, env, part.start + part.text.length);
      const e = p.parseExpr();
      if (!p.atEnd()) p.fail();
      keys.push({ side: 'src', get: e.get, desc, nullsFirst: nf });
      continue;
    }
    throw new SqlError(`column "${part.text.trim()}" does not exist`, '42703', part.start);
  }
  return keys;
}

function itemAtColumn(items: Item[], columns: ResultColumn[], colIdx: number, srcCols: ColumnRef[] | null): Item | null {
  let i = 0;
  for (const it of items) {
    const width = it.k === 'star' ? (srcCols?.length ?? columns.length) : 1;
    if (colIdx < i + width) return it;
    i += width;
  }
  return null;
}

function compareRows(keys: OrderKey[], a: { src: Value[]; out: Value[] }, b: { src: Value[]; out: Value[] }): number {
  for (const k of keys) {
    const x = k.get(k.side === 'src' ? a.src : a.out);
    const y = k.get(k.side === 'src' ? b.src : b.out);
    if (x.t === 'null' || y.t === 'null') {
      if (x.t === y.t) continue;
      return (x.t === 'null') === k.nullsFirst ? -1 : 1;
    }
    const c = compareValues(x, y) ?? 0;
    if (c !== 0) return k.desc ? -c : c;
  }
  return 0;
}

function aggType(it: Extract<Item, { k: 'agg' }>, kind: DbKind): string {
  const argCls = it.arg ? classifyType(it.arg.type) : 'int';
  switch (it.fn) {
    case 'COUNT':
      return kind === 'mssql' ? 'int' : typeName(kind, 'bigint');
    case 'AVG':
      return argCls === 'float' ? typeName(kind, 'float') : typeName(kind, 'numeric');
    case 'SUM':
      return argCls === 'int' ? (kind === 'postgres' ? 'int8' : typeName(kind, 'bigint')) : argCls === 'float' ? typeName(kind, 'float') : typeName(kind, 'numeric');
    default:
      return it.arg?.type ?? 'text';
  }
}

function aggregate(it: Extract<Item, { k: 'agg' }>, rows: Value[][], kind: DbKind): Value {
  let vals = it.arg ? rows.map((r) => it.arg!.get(r)).filter((v) => v.t !== 'null') : rows.map(() => vInt(1));
  if (it.distinct) {
    const seen = new Set<string>();
    vals = vals.filter((v) => {
      const k = JSON.stringify(v);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  switch (it.fn) {
    case 'COUNT':
      return vInt(vals.length);
    case 'MIN':
    case 'MAX': {
      if (!vals.length) return NUL;
      let best = vals[0];
      for (const v of vals) {
        const c = compareValues(v, best) ?? 0;
        if (it.fn === 'MIN' ? c < 0 : c > 0) best = v;
      }
      return best;
    }
    case 'SUM':
    case 'AVG': {
      if (!vals.length) return NUL;
      if (vals.every((v) => v.t === 'int') && it.fn === 'SUM') return vInt(vals.reduce((s, v) => s + BigInt((v as { v: string }).v), 0n));
      const nums = vals.map((v) => toNum(v) ?? 0);
      const sum = nums.reduce((s, x) => s + x, 0);
      if (vals.some((v) => v.t === 'float')) return vFloat(it.fn === 'SUM' ? sum : sum / nums.length);
      const scale = Math.max(0, ...vals.map((v) => (v.t === 'decimal' ? decimals(v.v) : 0)));
      if (it.fn === 'SUM') return vDec(sum.toFixed(scale));
      const avg = sum / nums.length;
      return vDec((Math.round(avg * 1e10) / 1e10).toFixed(kind === 'postgres' ? 10 : kind === 'mssql' ? 6 : 4));
    }
    default:
      return NUL;
  }
}

// ---------------------------------------------------------------------------
// DML
// ---------------------------------------------------------------------------

function nextIdentity(rows: Value[][], idx: number): number {
  let max = 0;
  for (const r of rows) {
    const n = toNum(r[idx]);
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0 && i < t.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function defaultValueFor(col: MockColumn, kind: DbKind): Value {
  if (!col.defaultValue) return NUL;
  const d = stripOuterParens(col.defaultValue);
  if (/now\(\)|current_timestamp|getdate|sysdatetime|sysutcdatetime|strftime/i.test(d)) return vDate(nowText(kind));
  if (/gen_random_uuid|newid|uuid\(\)/i.test(d)) return vText(kind === 'mssql' ? crypto.randomUUID().toUpperCase() : crypto.randomUUID());
  const str = /^N?'((?:[^']|'')*)'(::[\w. [\]]+)?$/.exec(d);
  if (str) {
    const content = str[1].replace(/''/g, "'");
    if (content === '{}' && /^_|\[\]$/.test(col.type)) return vJson([]);
    return coerceTo(vText(content), col, kind);
  }
  if (/^-?\d+(\.\d+)?$/.test(d)) return coerceTo(/\./.test(d) ? vDec(d) : vInt(d), col, kind);
  if (/^(true|false)$/i.test(d)) return coerceTo(vBool(/^true$/i.test(d)), col, kind);
  if (classifyType(col.type) === 'text' && /^[\w-]+$/.test(d)) return vText(d);
  return NUL;
}

function constraintError(t: MockTable, col: MockColumn, kind: DbKind): SqlError {
  if (kind === 'mssql')
    return new SqlError(`Cannot insert the value NULL into column '${col.name}', table '${t.schema}.${t.name}'; column does not allow nulls. INSERT fails.`, '515');
  if (kind === 'mysql') return new SqlError(`Column '${col.name}' cannot be null`, '1048');
  if (kind === 'sqlite') return new SqlError(`NOT NULL constraint failed: ${t.name}.${col.name}`, 'SQLITE_CONSTRAINT_NOTNULL');
  return new SqlError(`null value in column "${col.name}" of relation "${t.name}" violates not-null constraint`, '23502');
}

/** Build and append a row. `assigned` maps column index -> value. */
export function insertRow(db: MockDatabase, t: MockTable, assigned: Map<number, Value>): Value[] {
  const rows = rowsOf(db, t);
  const row: Value[] = t.columns.map((col, i) => {
    const given = assigned.get(i);
    if (given !== undefined) return coerceTo(given, col, db.kind);
    if (col.isIdentity) return vInt(nextIdentity(rows, i));
    if (col.isGenerated) return NUL;
    return defaultValueFor(col, db.kind);
  });
  t.columns.forEach((col, i) => {
    if (!col.nullable && !col.isGenerated && row[i].t === 'null') throw constraintError(t, col, db.kind);
  });
  if (t.primaryKey.length) {
    const pkIdx = t.primaryKey.map((k) => t.columns.findIndex((c) => c.name === k));
    const dup = rows.find((r) => pkIdx.every((i) => looseEqual(r[i], row[i])));
    if (dup) {
      const keyText = `(${t.primaryKey.join(', ')})=(${pkIdx.map((i) => displayValue(row[i])).join(', ')})`;
      throw db.kind === 'mssql'
        ? new SqlError(`Violation of PRIMARY KEY constraint 'PK_${t.name}'. Cannot insert duplicate key in object '${t.schema}.${t.name}'. The duplicate key value is ${keyText.split('=')[1]}.`, '2627')
        : new SqlError(`duplicate key value violates unique constraint "${t.name}_pkey"`, '23505', undefined, `Key ${keyText} already exists.`);
    }
  }
  rows.push(row);
  return row;
}

function parseTableRef(toks: Tok[], i: number, env: Env): { table: MockTable; next: number } {
  const first = toks[i];
  if (!first || (first.k !== 'id' && first.k !== 'qid')) throw new SqlError(`syntax error at or near "${first?.v ?? ''}"`, '42601', first?.pos);
  const parts = [first.v];
  let j = i + 1;
  while (toks[j]?.k === 'dot' && (toks[j + 1]?.k === 'id' || toks[j + 1]?.k === 'qid')) {
    parts.push(toks[j + 1].v);
    j += 2;
  }
  const name = parts[parts.length - 1];
  const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
  const table = resolveTable(env.db, schema, name);
  if (!table)
    throw new SqlError(
      env.kind === 'mssql' ? `Invalid object name '${parts.join('.')}'.` : `relation "${parts.join('.')}" does not exist`,
      env.kind === 'mssql' ? '208' : '42P01',
      first.pos
    );
  return { table, next: j };
}

function assertWritable(t: MockTable, verb: string): void {
  if (t.kind === 'table') return;
  throw new SqlError(
    t.kind === 'materialized_view' ? `cannot change materialized view "${t.name}"` : `cannot ${verb} view "${t.name}"`,
    '55000',
    undefined,
    t.kind === 'view' ? 'Views that do not select from a single table or view are not automatically updatable.' : undefined
  );
}

function returning(p: ExprParser, t: MockTable, rows: Value[][], rowsAffected: number): StatementOutcome {
  if (!p.eatKw('RETURNING')) {
    if (!p.atEnd()) p.fail();
    return { columns: [], rows: [], rowsAffected };
  }
  const idx: number[] = [];
  do {
    const tok = p.peek();
    if (tok?.k === 'star') {
      p.i++;
      idx.push(...t.columns.map((_, i) => i));
    } else if (tok && (tok.k === 'id' || tok.k === 'qid')) {
      const ci = findColumn(t.columns, tok.v);
      if (ci < 0) throw new SqlError(`column "${tok.v}" does not exist`, '42703', tok.pos);
      idx.push(ci);
      p.i++;
    } else p.fail();
  } while (p.eat('comma'));
  return {
    columns: idx.map((i) => ({ name: t.columns[i].name, type: t.columns[i].type })),
    rows: rows.map((r) => idx.map((i) => r[i])),
    rowsAffected
  };
}

function execInsert(sql: string, env: Env): StatementOutcome {
  const toks = tokenize(sql);
  let i = 1;
  if (isWord(toks[i], 'INTO')) i++;
  const { table, next } = parseTableRef(toks, i, env);
  assertWritable(table, 'insert into');
  i = next;
  let targetIdx = table.columns.map((_, k) => k);
  if (toks[i]?.k === 'lp') {
    const close = matchParen(toks, i);
    targetIdx = [];
    for (const t of toks.slice(i + 1, close)) {
      if (t.k === 'comma') continue;
      const ci = findColumn(table.columns, t.v);
      if (ci < 0) throw new SqlError(`column "${t.v}" of relation "${table.name}" does not exist`, '42703', t.pos);
      targetIdx.push(ci);
    }
    i = close + 1;
  }
  if (isWord(toks[i], 'DEFAULT') && isWord(toks[i + 1], 'VALUES')) {
    const row = insertRow(env.db, table, new Map());
    const p = new ExprParser(toks, [], env, sql.length);
    p.i = i + 2;
    return returning(p, table, [row], 1);
  }
  if (isWord(toks[i], 'SELECT') || isWord(toks[i], 'WITH')) {
    const sub = execSelectText(' '.repeat(toks[i].pos) + sql.slice(toks[i].pos), { env, ctes: new Map() });
    const inserted: Value[][] = [];
    for (const r of sub.rows) {
      const m = new Map<number, Value>();
      targetIdx.forEach((ci, k) => m.set(ci, r[k] ?? NUL));
      inserted.push(insertRow(env.db, table, m));
    }
    return { columns: [], rows: [], rowsAffected: inserted.length };
  }
  if (!isWord(toks[i], 'VALUES')) throw new SqlError(`syntax error at or near "${toks[i]?.v ?? ''}"`, '42601', toks[i]?.pos ?? sql.length);
  const p = new ExprParser(toks, [], env, sql.length);
  p.i = i + 1;
  const tuples: Value[][] = [];
  do {
    p.expect('lp');
    const vals: Value[] = [];
    do {
      if (p.isKw('DEFAULT')) {
        p.i++;
        vals.push({ t: 'text', v: '\u0000DEFAULT' });
      } else vals.push(p.parseExpr().get([]));
    } while (p.eat('comma'));
    p.expect('rp');
    if (vals.length !== targetIdx.length) throw new SqlError('INSERT has more expressions than target columns', '42601', toks[i].pos);
    tuples.push(vals);
  } while (p.eat('comma'));
  const inserted: Value[][] = [];
  const snapshot = rowsOf(env.db, table).length;
  try {
    for (const vals of tuples) {
      const m = new Map<number, Value>();
      targetIdx.forEach((ci, k) => {
        const v = vals[k];
        if (!(v.t === 'text' && v.v === '\u0000DEFAULT')) m.set(ci, v);
      });
      inserted.push(insertRow(env.db, table, m));
    }
  } catch (err) {
    rowsOf(env.db, table).length = snapshot;
    throw err;
  }
  return returning(p, table, inserted, inserted.length);
}

function execUpdate(sql: string, env: Env): StatementOutcome {
  const toks = tokenize(sql);
  let i = 1;
  if (isWord(toks[i], 'TOP')) i = toks[i + 1]?.k === 'lp' ? matchParen(toks, i + 1) + 1 : i + 2;
  const { table, next } = parseTableRef(toks, i, env);
  assertWritable(table, 'update');
  i = next;
  if (toks[i] && !isWord(toks[i], 'SET')) {
    if (isWord(toks[i], 'AS')) i++;
    i++;
  }
  const cols = table.columns.map((c) => ({ name: c.name, type: c.type }));
  const p = new ExprParser(toks, cols, env, sql.length);
  p.i = i;
  p.expectKw('SET');
  const sets: { idx: number; e: Expr }[] = [];
  do {
    const target = p.peek();
    if (!target || (target.k !== 'id' && target.k !== 'qid')) return p.fail();
    p.i++;
    let name = target.v;
    while (p.peek()?.k === 'dot') {
      p.i++;
      name = p.expect(p.peek()?.k === 'qid' ? 'qid' : 'id').v;
    }
    const ci = findColumn(cols, name);
    if (ci < 0) throw new SqlError(`column "${name}" of relation "${table.name}" does not exist`, '42703', target.pos);
    const eq = p.peek();
    if (!eq || eq.v !== '=') p.fail();
    p.i++;
    sets.push({ idx: ci, e: p.parseExpr() });
  } while (p.eat('comma'));
  if (p.isKw('FROM')) throw new SqlError('UPDATE ... FROM is not supported by the mock backend', '0A000', p.peek()!.pos);
  let pred: Pred = () => true;
  if (p.eatKw('WHERE')) pred = p.parseCondition();
  const rows = rowsOf(env.db, table);
  const touched: Value[][] = [];
  const pending: { row: Value[]; values: Value[] }[] = [];
  for (const r of rows) {
    if (pred(r) !== true) continue;
    const values = sets.map((s) => coerceTo(s.e.get(r), table.columns[s.idx], env.kind));
    sets.forEach((s, k) => {
      if (values[k].t === 'null' && !table.columns[s.idx].nullable) throw constraintError(table, table.columns[s.idx], env.kind);
    });
    pending.push({ row: r, values });
  }
  for (const { row, values } of pending) {
    sets.forEach((s, k) => (row[s.idx] = values[k]));
    touched.push(row);
  }
  return returning(p, table, touched, touched.length);
}

function execDelete(sql: string, env: Env): StatementOutcome {
  const toks = tokenize(sql);
  let i = 1;
  if (isWord(toks[i], 'TOP')) i = toks[i + 1]?.k === 'lp' ? matchParen(toks, i + 1) + 1 : i + 2;
  if (isWord(toks[i], 'FROM')) i++;
  const { table, next } = parseTableRef(toks, i, env);
  assertWritable(table, 'delete from');
  i = next;
  if (toks[i] && (toks[i].k === 'id' || toks[i].k === 'qid') && !isWord(toks[i], 'WHERE') && !isWord(toks[i], 'RETURNING')) {
    if (isWord(toks[i], 'AS')) i++;
    i++;
  }
  const cols = table.columns.map((c) => ({ name: c.name, type: c.type }));
  const p = new ExprParser(toks, cols, env, sql.length);
  p.i = i;
  let pred: Pred = () => true;
  if (p.eatKw('WHERE')) pred = p.parseCondition();
  const rows = rowsOf(env.db, table);
  const kept: Value[][] = [];
  const removed: Value[][] = [];
  for (const r of rows) (pred(r) === true ? removed : kept).push(r);
  rows.length = 0;
  rows.push(...kept);
  return returning(p, table, removed, removed.length);
}

// ---------------------------------------------------------------------------
// Utility statements
// ---------------------------------------------------------------------------

function textResult(column: string, lines: string[], type = 'text'): StatementOutcome {
  return { columns: [{ name: column, type }], rows: lines.map((l) => [vText(l)]) };
}

function explain(sql: string, env: Env): StatementOutcome {
  const inner = sql.replace(/^\s*EXPLAIN\s+(\(.*?\)\s*)?(ANALYZE\s+)?(VERBOSE\s+)?(QUERY\s+PLAN\s+)?/i, '');
  const analyze = /^\s*EXPLAIN\s+(\([^)]*ANALYZE[^)]*\)|ANALYZE)/i.test(sql);
  const fromMatch = /\bFROM\s+([\w."[\]`]+)/i.exec(inner);
  const parts = (fromMatch?.[1] ?? '').replace(/["[\]`]/g, '').split('.');
  const t = fromMatch ? resolveTable(env.db, parts.length > 1 ? parts[parts.length - 2] : null, parts[parts.length - 1]) : undefined;
  const rows = t ? rowsOf(env.db, t).length : 1;
  const name = t?.name ?? 'result';
  if (env.kind === 'sqlite') {
    return {
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'parent', type: 'INTEGER' },
        { name: 'notused', type: 'INTEGER' },
        { name: 'detail', type: 'TEXT' }
      ],
      rows: [[vInt(2), vInt(0), vInt(0), vText(/\bWHERE\b/i.test(inner) && t?.primaryKey.length ? `SEARCH ${name} USING INTEGER PRIMARY KEY (rowid=?)` : `SCAN ${name}`)]]
    };
  }
  if (env.kind === 'mysql') {
    return {
      columns: ['id', 'select_type', 'table', 'type', 'possible_keys', 'key', 'rows', 'filtered', 'Extra'].map((n) => ({ name: n, type: 'varchar' })),
      rows: [[vInt(1), vText('SIMPLE'), vText(name), vText('ALL'), NUL, NUL, vInt(rows), vDec('100.00'), /\bWHERE\b/i.test(inner) ? vText('Using where') : NUL]]
    };
  }
  const width = t ? t.columns.length * 12 : 4;
  const cost = (rows / 50 + 1).toFixed(2);
  const lines: string[] = [];
  const act = (r: number) => (analyze ? ` (actual time=0.012..${(r / 900 + 0.05).toFixed(3)} rows=${r} loops=1)` : '');
  const limit = /\bLIMIT\s+(\d+)/i.exec(inner);
  const order = /\bORDER\s+BY\s+([\w.", ]+?)(?:\s+(ASC|DESC))?(?:\s+LIMIT|\s*$)/i.exec(inner);
  let indent = '';
  if (limit) {
    lines.push(`Limit  (cost=0.00..${(Number(limit[1]) / 40).toFixed(2)} rows=${limit[1]} width=${width})${act(Number(limit[1]))}`);
    indent = '  ->  ';
  }
  if (order) {
    lines.push(`${indent}Sort  (cost=${cost}..${(Number(cost) * 1.1).toFixed(2)} rows=${rows} width=${width})${act(rows)}`);
    lines.push(`${indent ? '        ' : '  '}Sort Key: ${order[1].trim()}${order[2]?.toUpperCase() === 'DESC' ? ' DESC' : ''}`);
    indent = indent ? '        ->  ' : '  ->  ';
  }
  lines.push(`${indent}Seq Scan on ${name}  (cost=0.00..${cost} rows=${rows} width=${width})${act(rows)}`);
  const where = /\bWHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s*$)/i.exec(inner);
  if (where) lines.push(`${' '.repeat(indent.length + 2)}Filter: (${where[1].trim()})`);
  if (analyze) {
    lines.push('Planning Time: 0.091 ms');
    lines.push(`Execution Time: ${(rows / 900 + 0.08).toFixed(3)} ms`);
  }
  return textResult('QUERY PLAN', lines);
}

function show(sql: string, env: Env): StatementOutcome {
  const rest = sql.replace(/^\s*SHOW\s+/i, '').trim();
  const upper = rest.toUpperCase();
  if (env.kind === 'mysql') {
    if (/^(FULL\s+)?TABLES/.test(upper)) {
      const schema = /\b(?:FROM|IN)\s+`?(\w+)`?/i.exec(rest)?.[1] ?? env.db.defaultSchema;
      return textResult(`Tables_in_${schema}`, env.db.tables.filter((t) => t.schema === schema).map((t) => t.name), 'varchar');
    }
    if (/^DATABASES|^SCHEMAS/.test(upper)) return textResult('Database', [...env.db.schemas, 'information_schema', 'mysql', 'performance_schema', 'sys'], 'varchar');
    if (/^CREATE\s+TABLE/.test(upper)) {
      const name = rest.replace(/^CREATE\s+TABLE\s+/i, '').replace(/[`;]/g, '').trim();
      const parts = name.split('.');
      const t = resolveTable(env.db, parts.length > 1 ? parts[0] : null, parts[parts.length - 1]);
      if (!t) throw new SqlError(`Table '${env.database}.${name}' doesn't exist`, '1146');
      return { columns: [{ name: 'Table', type: 'varchar' }, { name: 'Create Table', type: 'varchar' }], rows: [[vText(t.name), vText(`CREATE TABLE \`${t.name}\` (...)`)]] };
    }
    if (/^(GLOBAL\s+|SESSION\s+)?VARIABLES/.test(upper))
      return {
        columns: [{ name: 'Variable_name', type: 'varchar' }, { name: 'Value', type: 'varchar' }],
        rows: [['autocommit', 'ON'], ['max_connections', '151'], ['sql_mode', 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES'], ['time_zone', 'SYSTEM'], ['version', '8.4.3']].map((r) => r.map(vText))
      };
    if (/^PROCESSLIST/.test(upper))
      return {
        columns: ['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'].map((n) => ({ name: n, type: 'varchar' })),
        rows: [[vInt(48213), vText(env.user), vText('10.0.4.77:51544'), vText(env.database), vText('Query'), vInt(0), vText('init'), vText('SHOW PROCESSLIST')]]
      };
  }
  const name = rest.replace(/;$/, '').toLowerCase();
  const known: Record<string, string> = {
    search_path: '"$user", public',
    server_version: '17.2',
    timezone: 'UTC',
    work_mem: '4MB',
    statement_timeout: '0',
    max_connections: '100',
    transaction_isolation: 'read committed',
    client_encoding: 'UTF8'
  };
  if (name === 'all')
    return {
      columns: ['name', 'setting', 'description'].map((n) => ({ name: n, type: 'text' })),
      rows: Object.entries(known).map(([k, v]) => [vText(k), vText(v), vText(`Sets ${k.replace(/_/g, ' ')}.`)])
    };
  if (!(name in known) && env.kind === 'postgres') throw new SqlError(`unrecognized configuration parameter "${name}"`, '42704');
  return textResult(name, [known[name] ?? 'on']);
}

function pragma(sql: string, env: Env): StatementOutcome {
  const m = /^\s*PRAGMA\s+(?:\w+\.)?(\w+)\s*(?:\(\s*['"]?([\w.]+)['"]?\s*\)|=\s*(\S+))?/i.exec(sql);
  const name = (m?.[1] ?? '').toLowerCase();
  const arg = m?.[2];
  if ((name === 'table_info' || name === 'table_xinfo') && arg) {
    const t = resolveTable(env.db, null, arg);
    if (!t) return { columns: [], rows: [] };
    return {
      columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'].map((n) => ({ name: n, type: n === 'name' || n === 'type' || n === 'dflt_value' ? 'TEXT' : 'INTEGER' })),
      rows: t.columns.map((c, i) => [vInt(i), vText(c.name), vText(c.type), vInt(c.nullable ? 0 : 1), c.defaultValue ? vText(c.defaultValue) : NUL, vInt(t.primaryKey.indexOf(c.name) + 1)])
    };
  }
  if (name === 'foreign_key_list' && arg) {
    const t = resolveTable(env.db, null, arg);
    return {
      columns: ['id', 'seq', 'table', 'from', 'to', 'on_update', 'on_delete', 'match'].map((n) => ({ name: n, type: 'TEXT' })),
      rows: (t?.foreignKeys ?? []).map((f, i) => [vInt(i), vInt(0), vText(f.refTable), vText(f.columns[0]), vText(f.refColumns[0]), vText(f.onUpdate ?? 'NO ACTION'), vText(f.onDelete ?? 'NO ACTION'), vText('NONE')])
    };
  }
  if (m?.[3] !== undefined) return { columns: [], rows: [], rowsAffected: 0 };
  const values: Record<string, Value> = { foreign_keys: vInt(1), journal_mode: vText('wal'), page_size: vInt(4096), user_version: vInt(3), encoding: vText('UTF-8') };
  return { columns: [{ name, type: '' }], rows: [[values[name] ?? vInt(0)]] };
}

function describe(sql: string, env: Env): StatementOutcome {
  const name = sql.replace(/^\s*(DESCRIBE|DESC)\s+/i, '').replace(/[`;]/g, '').trim().split(/\s+/)[0];
  const parts = name.split('.');
  const t = resolveTable(env.db, parts.length > 1 ? parts[0] : null, parts[parts.length - 1]);
  if (!t) throw new SqlError(`Table '${env.database}.${name}' doesn't exist`, '1146');
  return {
    columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'].map((n) => ({ name: n, type: 'varchar' })),
    rows: t.columns.map((c) => [
      vText(c.name),
      vText(c.type),
      vText(c.nullable ? 'YES' : 'NO'),
      vText(t.primaryKey.includes(c.name) ? 'PRI' : t.indexes.some((i) => i.columns[0] === c.name) ? 'MUL' : ''),
      c.defaultValue ? vText(c.defaultValue) : NUL,
      vText(c.isIdentity ? 'auto_increment' : '')
    ])
  };
}

function commandTag(sql: string): string {
  const words = sql.trim().replace(/\s+/g, ' ').split(' ').map((w) => w.toUpperCase().replace(/[^A-Z_]/g, ''));
  if (words[1] === 'OR' && words[2] === 'REPLACE') return `${words[0]} ${words[3]}`;
  if (words[1] === 'UNIQUE' || words[1] === 'MATERIALIZED' || words[1] === 'TEMP' || words[1] === 'TEMPORARY') return `${words[0]} ${words[2] === 'VIEW' ? 'VIEW' : words[2] === 'INDEX' ? 'INDEX' : words[2]}`;
  if (words[0] === 'REFRESH') return 'REFRESH MATERIALIZED VIEW';
  if (['VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'GRANT', 'REVOKE', 'COMMENT'].includes(words[0])) return words[0];
  if (words[0] === 'TRUNCATE') return 'TRUNCATE TABLE';
  return `${words[0]} ${words[1] ?? ''}`.trim();
}

function noticeMessages(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(/RAISE\s+(?:NOTICE|INFO|WARNING)\s+'((?:[^']|'')*)'/gi)) out.push(m[1].replace(/''/g, "'"));
  return out;
}

function truncate(sql: string, env: Env): void {
  const toks = tokenize(sql);
  let i = 1;
  if (isWord(toks[i], 'TABLE')) i++;
  if (isWord(toks[i], 'ONLY')) i++;
  for (;;) {
    const { table, next } = parseTableRef(toks, i, env);
    assertWritable(table, 'truncate');
    rowsOf(env.db, table).length = 0;
    if (toks[next]?.k !== 'comma') return;
    i = next + 1;
  }
}

/** Execute one statement (no trailing semicolon). Throws SqlError with a statement-relative position. */
export function execStatement(sql: string, env: Env): StatementOutcome {
  const kw = leadingKeyword(sql);
  switch (kw) {
    case 'SELECT':
    case 'WITH': {
      if (kw === 'WITH' && !/\bSELECT\b/i.test(sql.replace(/^[\s\S]*\)\s*/, ''))) {
        // WITH ... INSERT/UPDATE/DELETE: run the data-modifying tail.
        const tail = /\)\s*(INSERT|UPDATE|DELETE)\b[\s\S]*$/i.exec(sql);
        if (tail) return execStatement(' '.repeat(tail.index + tail[0].indexOf(tail[1])) + sql.slice(tail.index + tail[0].indexOf(tail[1])), env);
      }
      const r = execSelectText(sql, { env, ctes: new Map() });
      return { columns: r.columns, rows: r.rows, editable: r.editable, messages: noticeMessages(sql) };
    }
    case 'TABLE': {
      const name = sql.replace(/^\s*TABLE\s+/i, '');
      const r = execSelectText(`SELECT * FROM ${name}`, { env, ctes: new Map() });
      return { columns: r.columns, rows: r.rows, editable: r.editable };
    }
    case 'VALUES': {
      const toks = tokenize(sql);
      const p = new ExprParser(toks, [], env, sql.length);
      p.i = 1;
      const rows: Value[][] = [];
      do {
        p.expect('lp');
        const vals: Value[] = [];
        do {
          vals.push(p.parseExpr().get([]));
        } while (p.eat('comma'));
        p.expect('rp');
        rows.push(vals);
      } while (p.eat('comma'));
      const width = rows[0]?.length ?? 0;
      return { columns: Array.from({ length: width }, (_, i) => ({ name: `column${i + 1}`, type: 'text' })), rows };
    }
    case 'INSERT':
      return execInsert(sql, env);
    case 'UPDATE':
      return execUpdate(sql, env);
    case 'DELETE':
      return execDelete(sql, env);
    case 'MERGE':
    case 'REPLACE':
    case 'UPSERT':
      return { columns: [], rows: [], rowsAffected: 3 };
    case 'EXPLAIN':
      return explain(sql, env);
    case 'SHOW':
      return show(sql, env);
    case 'PRAGMA':
      return pragma(sql, env);
    case 'DESCRIBE':
    case 'DESC':
      return describe(sql, env);
    case 'TRUNCATE':
      truncate(sql, env);
      return { columns: [], rows: [], rowsAffected: 0, messages: ['TRUNCATE TABLE'] };
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'COMMENT':
    case 'GRANT':
    case 'REVOKE':
    case 'RENAME':
    case 'REINDEX':
    case 'VACUUM':
    case 'ANALYZE':
    case 'REFRESH':
    case 'CLUSTER':
      return { columns: [], rows: [], rowsAffected: 0, messages: [commandTag(sql)] };
    case 'BEGIN':
    case 'START':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE':
    case 'END':
      return { columns: [], rows: [], messages: [kw === 'START' ? 'START TRANSACTION' : kw] };
    case 'SET':
    case 'USE':
    case 'RESET':
    case 'DISCARD':
    case 'LISTEN':
    case 'NOTIFY':
    case 'DECLARE':
    case 'DEALLOCATE':
    case 'PREPARE':
      return { columns: [], rows: [], messages: kw === 'USE' && env.kind === 'mssql' ? [`Changed database context to '${sql.replace(/^\s*USE\s+/i, '').replace(/[[\];]/g, '').trim()}'.`] : [] };
    case 'PRINT': {
      const m = /^\s*PRINT\s+N?'((?:[^']|'')*)'/i.exec(sql);
      return { columns: [], rows: [], messages: [m ? m[1].replace(/''/g, "'") : sql.replace(/^\s*PRINT\s+/i, '')] };
    }
    case 'DO':
      return { columns: [], rows: [], messages: noticeMessages(sql) };
    case 'EXEC':
    case 'EXECUTE':
    case 'CALL': {
      const name = (/^\s*(?:EXEC|EXECUTE|CALL)\s+([\w.[\]"]+)/i.exec(sql)?.[1] ?? '').replace(/[[\]"]/g, '');
      const short = name.split('.').pop()?.toLowerCase() ?? '';
      const routine = env.db.routines.find((r) => r.name.toLowerCase() === short);
      if (!routine && !/^sp_|^xp_/i.test(short))
        throw new SqlError(env.kind === 'mssql' ? `Could not find stored procedure '${name}'.` : `procedure ${name}() does not exist`, env.kind === 'mssql' ? '2812' : '42883');
      if (short === 'sp_who' || short === 'sp_who2')
        return {
          columns: ['spid', 'status', 'loginame', 'hostname', 'dbname', 'cmd'].map((n) => ({ name: n, type: 'nvarchar' })),
          rows: [[vInt(53), vText('runnable'), vText(env.user), vText('MACBOOK-PRO'), vText(env.database), vText('SELECT')], [vInt(61), vText('sleeping'), vText('etl_svc'), vText('ETL-02'), vText(env.database), vText('AWAITING COMMAND')]]
        };
      return { columns: [], rows: [], rowsAffected: routine?.kind === 'procedure' ? 2 : undefined, messages: kw === 'CALL' ? ['CALL'] : [] };
    }
    default: {
      const first = tokenize(sql)[0];
      throw new SqlError(`syntax error at or near "${first?.v ?? sql.trim().split(/\s+/)[0] ?? ''}"`, '42601', first?.pos ?? 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Literals for rendered DML (db.applyChanges previews)
// ---------------------------------------------------------------------------

const quoteText = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function sqlLiteral(kind: DbKind, v: Value): string {
  switch (v.t) {
    case 'null':
      return 'NULL';
    case 'bool':
      return kind === 'mssql' || kind === 'sqlite' ? (v.v ? '1' : '0') : v.v ? 'TRUE' : 'FALSE';
    case 'int':
    case 'decimal':
      return v.v;
    case 'float':
      return Number.isFinite(v.v) ? String(v.v) : quoteText(String(v.v));
    case 'text':
      return kind === 'mssql' ? `N${quoteText(v.v)}` : quoteText(v.v);
    case 'datetime':
      return quoteText(v.v);
    case 'json': {
      const s = typeof v.v === 'string' ? v.v : JSON.stringify(v.v);
      return kind === 'mssql' ? `N${quoteText(s)}` : quoteText(s);
    }
    case 'bytes':
      return kind === 'postgres' ? `'\\x${v.hex}'` : kind === 'sqlite' ? `X'${v.hex}'` : `0x${v.hex}`;
  }
}

export function renderPkWhere(kind: DbKind, pk: Record<string, Value>): string {
  return Object.entries(pk)
    .map(([k, v]) => (v.t === 'null' ? `${quoteIdent(kind, k)} IS NULL` : `${quoteIdent(kind, k)} = ${sqlLiteral(kind, v)}`))
    .join(' AND ');
}

export function tableName(kind: DbKind, t: { schema: string; name: string }): string {
  return kind === 'sqlite' ? quoteIdent(kind, t.name) : qualifiedName(kind, t.schema, t.name);
}

/** Pseudo-random but stable latency per statement. */
export function latencyFor(sql: string, rows: number): number {
  let h = 0;
  for (let i = 0; i < sql.length; i++) h = (h * 31 + sql.charCodeAt(i)) | 0;
  const rng = new Rng(Math.abs(h) + 1);
  return Math.round(60 + rng.next() * 240 + rows / 40);
}
