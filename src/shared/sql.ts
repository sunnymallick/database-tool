/**
 * SQL text helpers shared by main (execution, read-only enforcement, AI tools)
 * and renderer (run statement at cursor, parameter prompts, change previews).
 *
 * Everything is built on one small dialect-aware lexer so statement
 * splitting, keyword classification, and parameter scanning agree on what is
 * code and what is a string, quoted identifier, comment, or dollar-quoted
 * body. Ported from dbTool's `db/mod.rs` helpers and extended:
 *  - `--`, `/* *\/` (nested for Postgres and SQL Server), MySQL `#` comments
 *  - '' strings with doubled quotes; backslash escapes in MySQL and Postgres E''
 *  - "", `` ` ``, and [bracket] (SQL Server, SQLite) quoted identifiers
 *  - Postgres $$ / $tag$ dollar quoting
 *  - SQL Server `GO [n]` batch separators and MySQL `DELIMITER` lines
 *  - BEGIN...END bodies of CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT kept whole
 *
 * OWNER: data-layer slice. Exported signatures are used by the UI and AI
 * slices; keep them backward compatible.
 */
import type { DbKind, Value } from './types';

export interface StatementSpan {
  /** Statement text without the trailing terminator, trimmed. */
  text: string;
  /** Offsets into the original script: [start, end). */
  start: number;
  end: number;
}

/** A SQL Server batch (text between `GO` lines). `repeat` is the `GO n` count. */
export interface BatchSpan extends StatementSpan {
  repeat: number;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenType =
  | 'space'
  | 'comment'
  | 'string'
  | 'qident'
  | 'dollar'
  | 'word'
  | 'number'
  | 'punct'
  /** Statement terminator (`;`, or the MySQL DELIMITER in effect). */
  | 'term'
  /** SQL Server batch separator line; `arg` holds the repeat count. */
  | 'go'
  /** MySQL client `DELIMITER x` line; `arg` holds the new delimiter. */
  | 'delimiter';

interface Token {
  type: TokenType;
  start: number;
  end: number;
  arg?: string;
}

interface Dialect {
  hashComments: boolean;
  nestedComments: boolean;
  /** MySQL: backslash escapes in '' and "" strings, and "" is a string. */
  mysqlStrings: boolean;
  eStrings: boolean;
  dollarQuotes: boolean;
  brackets: boolean;
  goBatches: boolean;
  delimiterCommand: boolean;
  /** SQL Server `#temp` / `##global` names lex as words. */
  hashWords: boolean;
}

function dialectOf(kind?: DbKind): Dialect {
  return {
    hashComments: kind === 'mysql',
    nestedComments: kind === 'postgres' || kind === 'mssql',
    mysqlStrings: kind === 'mysql',
    // Unknown dialect: be permissive so Postgres scripts split correctly.
    eStrings: kind === 'postgres' || kind === undefined,
    dollarQuotes: kind === 'postgres' || kind === undefined,
    brackets: kind === 'mssql' || kind === 'sqlite' || kind === undefined,
    goBatches: kind === 'mssql',
    delimiterCommand: kind === 'mysql',
    hashWords: kind === 'mssql'
  };
}

const GO_LINE = /[ \t]*go(?:[ \t]+(\d+))?[ \t]*(?:--[^\r\n]*)?(?=\r?\n|$)/iy;
const DELIMITER_LINE = /[ \t]*delimiter[ \t]+(\S+)[ \t]*(?=\r?\n|$)/iy;
const DOLLAR_TAG = /\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
/** Hex (0x1F), binary (0b101), or decimal with optional fraction and exponent. */
const NUMBER = /0[xX][0-9A-Fa-f]*|0[bB][01]+|\d+(?:\.\d*)?(?:[eE][-+]?\d+)?/y;

function isWordStart(code: number, d: Dialect): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 /* _ */ ||
    code === 64 /* @ */ ||
    (code === 35 /* # */ && d.hashWords) ||
    code >= 0x80
  );
}

function isWordPart(code: number, d: Dialect): boolean {
  return (
    isWordStart(code, d) ||
    (code >= 48 && code <= 57) ||
    code === 36 /* $ */ ||
    (code === 35 && d.hashWords)
  );
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
}

function lex(sql: string, kind?: DbKind): Token[] {
  const d = dialectOf(kind);
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  let delimiter = ';';
  let lineStart = true;

  // Skip a quoted run starting at `from` (the opening quote). Returns the index after the closing quote.
  const skipQuoted = (from: number, close: string, backslash: boolean): number => {
    let j = from + 1;
    while (j < n) {
      const ch = sql[j];
      if (backslash && ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === close) {
        if (sql[j + 1] === close) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n;
  };

  while (i < n) {
    if (lineStart) {
      lineStart = false;
      if (d.goBatches) {
        GO_LINE.lastIndex = i;
        const m = GO_LINE.exec(sql);
        if (m) {
          out.push({ type: 'go', start: i, end: i + m[0].length, arg: m[1] ?? '1' });
          i += m[0].length;
          continue;
        }
      }
      if (d.delimiterCommand) {
        DELIMITER_LINE.lastIndex = i;
        const m = DELIMITER_LINE.exec(sql);
        if (m) {
          delimiter = m[1];
          out.push({ type: 'delimiter', start: i, end: i + m[0].length, arg: m[1] });
          i += m[0].length;
          continue;
        }
      }
    }

    const code = sql.charCodeAt(i);
    const c = sql[i];
    const next = sql[i + 1];

    if (isSpace(code)) {
      let j = i;
      while (j < n && isSpace(sql.charCodeAt(j))) {
        if (sql[j] === '\n') {
          j++;
          lineStart = true;
          break;
        }
        j++;
      }
      out.push({ type: 'space', start: i, end: j });
      i = j;
      continue;
    }

    // MySQL only treats `--` as a comment when followed by whitespace (`--1` is minus minus one).
    const dashComment =
      c === '-' && next === '-' && (!d.mysqlStrings || i + 2 >= n || isSpace(sql.charCodeAt(i + 2)));
    if (dashComment || (c === '#' && d.hashComments)) {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = n;
      out.push({ type: 'comment', start: i, end: j });
      i = j;
      continue;
    }

    if (c === '/' && next === '*') {
      let j = i + 2;
      let depth = 1;
      while (j < n && depth > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else if (d.nestedComments && sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else j++;
      }
      out.push({ type: 'comment', start: i, end: Math.min(j, n) });
      i = Math.min(j, n);
      continue;
    }

    if (delimiter === ';' ? c === ';' : sql.startsWith(delimiter, i)) {
      out.push({ type: 'term', start: i, end: i + delimiter.length });
      i += delimiter.length;
      continue;
    }

    if (c === "'") {
      const j = skipQuoted(i, "'", d.mysqlStrings);
      out.push({ type: 'string', start: i, end: j });
      i = j;
      continue;
    }

    if (c === '"') {
      const j = skipQuoted(i, '"', d.mysqlStrings);
      out.push({ type: d.mysqlStrings ? 'string' : 'qident', start: i, end: j });
      i = j;
      continue;
    }

    if (c === '`') {
      const j = skipQuoted(i, '`', false);
      out.push({ type: 'qident', start: i, end: j });
      i = j;
      continue;
    }

    if (c === '[' && d.brackets) {
      const j = skipQuoted(i, ']', false);
      out.push({ type: 'qident', start: i, end: j });
      i = j;
      continue;
    }

    if (c === '$' && d.dollarQuotes && !(i > 0 && isWordPart(sql.charCodeAt(i - 1), d))) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const j = close === -1 ? n : close + tag.length;
        out.push({ type: 'dollar', start: i, end: j });
        i = j;
        continue;
      }
    }

    if (isWordStart(code, d)) {
      let j = i + 1;
      // A custom MySQL delimiter such as `$$` must not be swallowed by `END$$`.
      while (j < n && isWordPart(sql.charCodeAt(j), d) && !(delimiter !== ';' && sql.startsWith(delimiter, j))) j++;
      // Prefixed string literals: E'..' (backslash escapes), N'..', X'..', B'..'.
      if (j === i + 1 && sql[j] === "'") {
        const p = c.toLowerCase();
        if ((p === 'e' && d.eStrings) || p === 'n' || p === 'x' || p === 'b') {
          const end = skipQuoted(j, "'", d.mysqlStrings || p === 'e');
          out.push({ type: 'string', start: i, end });
          i = end;
          continue;
        }
      }
      out.push({ type: 'word', start: i, end: j });
      i = j;
      continue;
    }

    if (code >= 48 && code <= 57) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(sql);
      const j = m ? i + m[0].length : i + 1;
      out.push({ type: 'number', start: i, end: j });
      i = j;
      continue;
    }

    out.push({ type: 'punct', start: i, end: i + 1 });
    i++;
  }
  return out;
}

const isSignificant = (t: Token): boolean => t.type !== 'space' && t.type !== 'comment';

// ---------------------------------------------------------------------------
// Statement and batch splitting
// ---------------------------------------------------------------------------

/** Words after BEGIN that start a transaction rather than a block. */
const BEGIN_NOT_BLOCK = new Set(['transaction', 'tran', 'work', 'distributed', 'dialog', 'conversation', 'deferred', 'immediate', 'exclusive']);
/** Words after END that close a construct we do not track (END IF, END LOOP, ...). */
const END_NOT_BLOCK = new Set(['if', 'loop', 'while', 'repeat', 'for', 'conversation']);
const ROUTINE_WORDS = new Set(['procedure', 'proc', 'function', 'trigger', 'event']);

type RoutineMode = 'none' | 'blocks' | 'batch';

/**
 * Decides how a CREATE statement's body is delimited from its first words:
 * SQL Server module DDL runs to the end of the batch; elsewhere BEGIN...END
 * blocks are tracked so semicolons inside the body do not split it.
 */
function detectRoutine(words: string[], kind?: DbKind): RoutineMode {
  const first = words[0];
  const isMssql = kind === 'mssql';
  if (first !== 'create' && !(isMssql && first === 'alter')) return 'none';
  const rest = words.slice(1);
  if (isMssql) return rest.some((w) => ROUTINE_WORDS.has(w) || w === 'view') ? 'batch' : 'none';
  return rest.some((w) => ROUTINE_WORDS.has(w) && (w !== 'event' || kind === 'mysql' || kind === undefined)) ? 'blocks' : 'none';
}

interface SplitResult {
  statements: StatementSpan[];
  batches: BatchSpan[];
}

function makeSpan(sql: string, start: number, end: number, tokens: Token[], from: number, to: number): StatementSpan | null {
  let hasContent = false;
  for (let k = from; k < to; k++) {
    if (isSignificant(tokens[k])) {
      hasContent = true;
      break;
    }
  }
  if (!hasContent) return null;
  const raw = sql.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  return { text, start: start + lead, end: start + lead + text.length };
}

function split(sql: string, kind?: DbKind): SplitResult {
  const tokens = lex(sql, kind);
  const statements: StatementSpan[] = [];
  const batches: BatchSpan[] = [];

  let stmtStart = 0;
  let stmtTok = 0;
  let batchStart = 0;
  let batchTok = 0;
  let depth = 0;
  let routine: RoutineMode = 'none';
  let words: string[] = [];
  let sawParen = false;
  let blocks: string[] = [];
  /** Lower-cased previous significant token when it was a word (`END CASE` closes, it does not open). */
  let prevWord = '';

  const nextWord = (from: number): string => {
    for (let k = from + 1; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === 'word') return sql.slice(t.start, t.end).toLowerCase();
      if (isSignificant(t)) return '';
    }
    return '';
  };

  const endStatement = (end: number, tokEnd: number, nextStart: number) => {
    const span = makeSpan(sql, stmtStart, end, tokens, stmtTok, tokEnd);
    if (span) statements.push(span);
    stmtStart = nextStart;
    stmtTok = tokEnd + 1;
    depth = 0;
    routine = 'none';
    words = [];
    sawParen = false;
    blocks = [];
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    const afterEnd = prevWord === 'end';
    if (isSignificant(tok)) prevWord = tok.type === 'word' ? sql.slice(tok.start, tok.end).toLowerCase() : '';
    switch (tok.type) {
      case 'punct': {
        const ch = sql[tok.start];
        if (ch === '(') {
          depth++;
          sawParen = true;
        } else if (ch === ')') depth = Math.max(0, depth - 1);
        break;
      }
      case 'word': {
        const w = sql.slice(tok.start, tok.end).toLowerCase();
        if (!sawParen && words.length < 8) {
          words.push(w);
          if (routine === 'none') routine = detectRoutine(words, kind);
        }
        if (routine === 'blocks' || (kind === 'mssql' && routine === 'none')) {
          if (w === 'begin') {
            if (!BEGIN_NOT_BLOCK.has(nextWord(k))) blocks.push('begin');
          } else if (w === 'case' && !afterEnd) blocks.push('case');
          else if (w === 'end' && !END_NOT_BLOCK.has(nextWord(k))) blocks.pop();
        }
        break;
      }
      case 'term':
        if (depth === 0 && blocks.length === 0 && routine !== 'batch') endStatement(tok.start, k, tok.end);
        break;
      case 'go': {
        endStatement(tok.start, k, tok.end);
        const span = makeSpan(sql, batchStart, tok.start, tokens, batchTok, k);
        if (span) batches.push({ ...span, repeat: Math.max(1, Number(tok.arg ?? '1')) });
        batchStart = tok.end;
        batchTok = k + 1;
        break;
      }
      case 'delimiter':
        endStatement(tok.start, k, tok.end);
        break;
      default:
        break;
    }
  }
  endStatement(sql.length, tokens.length, sql.length);
  const lastBatch = makeSpan(sql, batchStart, sql.length, tokens, batchTok, tokens.length);
  if (lastBatch) batches.push({ ...lastBatch, repeat: 1 });
  return { statements, batches };
}

/**
 * Split a script into statements on top-level terminators (not inside
 * quotes, comments, dollar bodies, parentheses, or routine BEGIN...END
 * bodies), plus `GO` lines for SQL Server and `DELIMITER` for MySQL.
 */
export function splitStatements(sql: string, kind?: DbKind): StatementSpan[] {
  return split(sql, kind).statements;
}

/**
 * Units of execution. SQL Server runs whole batches between `GO` lines (so
 * variables, IF/ELSE, and procedure bodies stay together); every other engine
 * runs one statement at a time, so a batch is a statement.
 */
export function splitBatches(sql: string, kind?: DbKind): BatchSpan[] {
  if (kind === 'mssql') return split(sql, kind).batches;
  return split(sql, kind).statements.map((s) => ({ ...s, repeat: 1 }));
}

/** The statement containing (or nearest before) a cursor offset. */
export function statementAt(sql: string, offset: number, kind?: DbKind): StatementSpan | null {
  const stmts = splitStatements(sql, kind);
  if (stmts.length === 0) return null;
  for (const s of stmts) if (offset >= s.start && offset <= s.end) return s;
  let best: StatementSpan | null = null;
  for (const s of stmts) if (s.end <= offset) best = s;
  return best ?? stmts[0];
}

/** True when the text contains anything besides whitespace and comments. */
export function hasSqlContent(sql: string, kind?: DbKind): boolean {
  return lex(sql, kind).some(isSignificant);
}

/** Replace every comment with a single space. Strings and quoted identifiers are left alone. */
export function stripComments(sql: string, kind?: DbKind): string {
  let out = '';
  let last = 0;
  for (const t of lex(sql, kind)) {
    if (t.type !== 'comment') continue;
    out += sql.slice(last, t.start) + ' ';
    last = t.end;
  }
  return out + sql.slice(last);
}

/** First keyword of the statement, upper-cased, ignoring leading comments and parentheses. */
export function leadingKeyword(sql: string, kind?: DbKind): string {
  for (const t of lex(sql, kind)) {
    if (!isSignificant(t)) continue;
    if (t.type === 'punct' && sql[t.start] === '(') continue;
    return t.type === 'word' ? sql.slice(t.start, t.end).toUpperCase() : '';
  }
  return '';
}

/** True when `keyword` appears as a bare word (not inside strings, quoted identifiers, or comments). */
export function containsKeyword(sql: string, keyword: string, kind?: DbKind): boolean {
  const want = keyword.toLowerCase();
  return lex(sql, kind).some((t) => t.type === 'word' && sql.slice(t.start, t.end).toLowerCase() === want);
}

// ---------------------------------------------------------------------------
// Read-only classification
// ---------------------------------------------------------------------------

const COMMON_READ_STARTERS = ['select', 'with', 'values', 'explain', 'set', 'begin', 'commit', 'rollback', 'savepoint', 'release'];
const READ_STARTERS: Record<DbKind | 'any', Set<string>> = {
  postgres: new Set([...COMMON_READ_STARTERS, 'show', 'table', 'start', 'end', 'abort', 'declare', 'fetch', 'move', 'close']),
  mysql: new Set([...COMMON_READ_STARTERS, 'show', 'describe', 'desc', 'use', 'start']),
  sqlite: new Set([...COMMON_READ_STARTERS, 'pragma', 'end']),
  // T-SQL control flow is allowed because every statement is scanned for write keywords below.
  mssql: new Set([
    ...COMMON_READ_STARTERS,
    'use', 'declare', 'print', 'if', 'else', 'while', 'end', 'return', 'break', 'continue', 'throw', 'waitfor',
    'open', 'fetch', 'close', 'deallocate'
  ]),
  any: new Set([...COMMON_READ_STARTERS, 'show', 'table', 'describe', 'desc', 'use', 'start', 'end', 'abort', 'pragma', 'declare', 'fetch', 'close'])
};

/** Words that make a statement a write wherever they appear outside strings and comments. */
const WRITE_WORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'rename',
  'replace', 'call', 'exec', 'execute', 'into', 'vacuum', 'reindex', 'attach', 'detach', 'kill', 'shutdown', 'dbcc',
  'reconfigure', 'openquery', 'openrowset', 'opendatasource'
]);
const EXTRA_WRITE_WORDS: Partial<Record<DbKind, Set<string>>> = {
  mssql: new Set(['backup', 'restore', 'checkpoint', 'bulk', 'setuser', 'revert', 'deny']),
  mysql: new Set(['flush', 'purge', 'install', 'uninstall'])
};
/** Write words that are harmless string functions when called: REPLACE(...), MySQL INSERT(...). */
const CALLABLE_OK = new Set(['replace', 'insert']);
/** Functions with side effects, flagged when called. */
const WRITE_FUNCTIONS = new Set([
  'nextval', 'setval', 'set_config', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
  'pg_switch_wal', 'pg_create_restore_point', 'pg_promote', 'lo_import', 'lo_export', 'lo_unlink', 'lo_create',
  'lo_from_bytea', 'lo_put', 'dblink_exec', 'load_extension'
]);
/** SET forms that change privileges, persistence, or the server-side read-only guard. */
const SET_DENY = new Set(['global', 'persist', 'persist_only', 'password', 'role', 'authorization', 'write']);
const PRAGMA_READ_CALLS = new Set([
  'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check',
  'integrity_check', 'quick_check', 'table_list'
]);
const PRAGMA_WRITE_NOARG = new Set(['optimize', 'incremental_vacuum', 'wal_checkpoint']);

function pragmaIsWrite(sql: string, toks: Token[]): boolean {
  if (toks.some((t) => t.type === 'punct' && sql[t.start] === '=')) return true;
  const words = toks.filter((t) => t.type === 'word').map((t) => sql.slice(t.start, t.end).toLowerCase());
  // words[0] is PRAGMA; the name is the last word before any argument list.
  const paren = toks.findIndex((t) => t.type === 'punct' && sql[t.start] === '(');
  const nameWords = paren === -1 ? words : toks.slice(0, paren).filter((t) => t.type === 'word').map((t) => sql.slice(t.start, t.end).toLowerCase());
  const name = nameWords[nameWords.length - 1] ?? '';
  if (paren !== -1) return !PRAGMA_READ_CALLS.has(name);
  return PRAGMA_WRITE_NOARG.has(name);
}

/** The keyword that makes one statement a write, or null when it is read-only. */
function statementWriteKeyword(sql: string, kind?: DbKind): string | null {
  const toks = lex(sql, kind).filter(isSignificant);
  const firstIdx = toks.findIndex((t) => !(t.type === 'punct' && sql[t.start] === '('));
  if (firstIdx === -1) return null;
  const firstTok = toks[firstIdx];
  if (firstTok.type !== 'word') return null;
  const first = sql.slice(firstTok.start, firstTok.end).toLowerCase();
  const starters = READ_STARTERS[kind ?? 'any'];
  if (!starters.has(first)) return first.toUpperCase();

  const wordAt = (k: number): string => {
    const t = toks[k];
    return t && t.type === 'word' ? sql.slice(t.start, t.end).toLowerCase() : '';
  };
  if (first === 'start' && wordAt(firstIdx + 1) !== 'transaction') return 'START';
  if (first === 'pragma' && pragmaIsWrite(sql, toks)) return 'PRAGMA';

  const extra = kind ? EXTRA_WRITE_WORDS[kind] : undefined;
  for (let k = firstIdx; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'word') continue;
    const w = sql.slice(t.start, t.end).toLowerCase();
    const prev = toks[k - 1];
    const next = toks[k + 1];
    // `t.update` and `update.x` are identifiers, not keywords.
    if ((prev && prev.type === 'punct' && sql[prev.start] === '.') || (next && next.type === 'punct' && sql[next.start] === '.')) continue;
    const isCall = !!next && next.type === 'punct' && sql[next.start] === '(';
    if (isCall && WRITE_FUNCTIONS.has(w)) return w.toUpperCase();
    if ((WRITE_WORDS.has(w) || extra?.has(w)) && !(isCall && CALLABLE_OK.has(w))) return w.toUpperCase();
    if (first === 'set' && (SET_DENY.has(w) || w.includes('read_only') || w.includes('query_only'))) return 'SET';
  }
  return null;
}

/**
 * The first keyword that makes the script a write (e.g. `UPDATE`), or null
 * when every statement is read-only. Conservative by design: a read-only
 * connection would rather refuse an unusual read than permit a write.
 *
 * Rules: each statement must start with an allow-listed keyword (SELECT,
 * WITH, SHOW, EXPLAIN, ...), and no statement may contain a write keyword
 * anywhere outside strings and comments. That covers WITH ... DELETE,
 * SELECT ... INTO, EXPLAIN ANALYZE UPDATE, SELECT ... FOR UPDATE, T-SQL
 * batches without semicolons, `PRAGMA x = y`, `SET ROLE`, and side-effecting
 * functions such as nextval().
 */
export function writeKeyword(sql: string, kind?: DbKind): string | null {
  return findWrite(sql, kind)?.keyword ?? null;
}

export interface WriteHit {
  keyword: string;
  statementIndex: number;
  statement: StatementSpan;
}

/** Like `writeKeyword`, plus which statement is the write (for pointing the editor at it). */
export function findWrite(sql: string, kind?: DbKind): WriteHit | null {
  const stmts = splitStatements(sql, kind);
  for (let i = 0; i < stmts.length; i++) {
    const keyword = statementWriteKeyword(stmts[i].text, kind);
    if (keyword) return { keyword, statementIndex: i, statement: stmts[i] };
  }
  return null;
}

/** Conservative read-only check for one statement. */
export function isReadOnlyStatement(sql: string, kind?: DbKind): boolean {
  return statementWriteKeyword(sql, kind) === null;
}

/** True when every statement in the script is read-only. */
export function isReadOnlyScript(sql: string, kind?: DbKind): boolean {
  return writeKeyword(sql, kind) === null;
}

// ---------------------------------------------------------------------------
// :name parameters
// ---------------------------------------------------------------------------

interface ParamOccurrence {
  name: string;
  start: number;
  end: number;
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function findParameters(sql: string, kind?: DbKind): ParamOccurrence[] {
  const toks = lex(sql, kind);
  const out: ParamOccurrence[] = [];
  for (let k = 0; k < toks.length - 1; k++) {
    const t = toks[k];
    if (t.type !== 'punct' || sql[t.start] !== ':') continue;
    const next = toks[k + 1];
    if (next.type !== 'word' || next.start !== t.end) continue;
    const prev = toks[k - 1];
    // `x::int` casts and `arr[1:n]` slices: the colon is glued to the token before it.
    if (prev && prev.end === t.start && (prev.type === 'word' || prev.type === 'number' || prev.type === 'qident' || (prev.type === 'punct' && sql[prev.start] === ':'))) continue;
    const name = sql.slice(next.start, next.end);
    if (!PARAM_NAME.test(name)) continue;
    out.push({ name, start: t.start, end: next.end });
    k++;
  }
  return out;
}

/** Names of `:name` parameters in order of first appearance (skips `::casts`, `:=`, quotes, comments, dollar bodies). */
export function scanParameters(sql: string, kind?: DbKind): string[] {
  const names: string[] = [];
  for (const p of findParameters(sql, kind)) if (!names.includes(p.name)) names.push(p.name);
  return names;
}

export interface SubstitutedSql {
  sql: string;
  /** Maps an offset in the substituted SQL back to the original text. */
  toOriginalOffset(offset: number): number;
}

/** Like `substituteParameters`, plus an offset map so engine error positions can point at the original text. */
export function substituteParametersMapped(sql: string, values: Record<string, string>, kind?: DbKind): SubstitutedSql {
  const edits: { origStart: number; origEnd: number; outStart: number; outEnd: number }[] = [];
  let out = '';
  let last = 0;
  for (const p of findParameters(sql, kind)) {
    if (!Object.prototype.hasOwnProperty.call(values, p.name)) continue;
    out += sql.slice(last, p.start);
    const literal = parameterLiteral(values[p.name], kind);
    edits.push({ origStart: p.start, origEnd: p.end, outStart: out.length, outEnd: out.length + literal.length });
    out += literal;
    last = p.end;
  }
  out += sql.slice(last);
  return {
    sql: out,
    toOriginalOffset(offset: number): number {
      let delta = 0;
      for (const e of edits) {
        if (offset < e.outStart) break;
        if (offset < e.outEnd) return e.origStart;
        delta = e.origEnd - e.outEnd;
      }
      return offset + delta;
    }
  };
}

/**
 * Replace `:name` parameters with SQL literals built from typed text:
 * NULL stays NULL, numbers and booleans go bare, text already wrapped in
 * single quotes is used verbatim, everything else is quoted for the dialect.
 * Names without a value are left untouched.
 */
export function substituteParameters(sql: string, values: Record<string, string>, kind?: DbKind): string {
  return substituteParametersMapped(sql, values, kind).sql;
}

const NUMERIC_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const QUOTED_TEXT = /^'(?:[^']|'')*'$/;

/** Render a typed parameter value as a SQL literal for the dialect. */
export function parameterLiteral(input: string, kind?: DbKind): string {
  const t = input.trim();
  if (/^null$/i.test(t)) return 'NULL';
  if (/^(true|false)$/i.test(t)) {
    const truthy = t.toLowerCase() === 'true';
    return kind === 'mssql' || kind === 'sqlite' ? (truthy ? '1' : '0') : truthy ? 'TRUE' : 'FALSE';
  }
  if (NUMERIC_TEXT.test(t)) return t;
  if (QUOTED_TEXT.test(t)) return t;
  return quoteString(kind, input);
}

// ---------------------------------------------------------------------------
// Identifiers and literals
// ---------------------------------------------------------------------------

/** Quote an identifier for the engine. */
export function quoteIdent(kind: DbKind, name: string): string {
  switch (kind) {
    case 'mysql':
      return `\`${name.replace(/`/g, '``')}\``;
    case 'mssql':
      return `[${name.replace(/]/g, ']]')}]`;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

/** `schema.table` quoted for the engine (schema omitted when empty). */
export function qualifiedName(kind: DbKind, schema: string, table: string): string {
  return schema ? `${quoteIdent(kind, schema)}.${quoteIdent(kind, table)}` : quoteIdent(kind, table);
}

/** A string literal. MySQL (default sql_mode) also needs backslashes escaped; SQL Server uses N'' to keep Unicode. */
function quoteString(kind: DbKind | undefined, s: string): string {
  const body = s.replace(/'/g, "''");
  if (kind === 'mysql') return `'${body.replace(/\\/g, '\\\\')}'`;
  if (kind === 'mssql') return `N'${body}'`;
  return `'${body}'`;
}

/**
 * Date/time text in a form SQL Server reads the same under every
 * SET DATEFORMAT / login language: `YYYYMMDD` for dates, ISO 8601 with a `T`
 * for date-times (`2024-01-05 10:00:00.000` is read as May 1 by a British
 * login when the column is DATETIME). Text in any other shape is returned as is.
 */
export function mssqlDateTimeText(text: string): string {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) return `${date[1]}${date[2]}${date[3]}`;
  const dt = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?) ?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  return dt ? `${dt[1]}T${dt[2]}${dt[3] ?? ''}` : text;
}

/**
 * Render a cell value as a SQL literal for previews and generated scripts.
 * Execution paths bind parameters instead; this is what the user sees.
 */
export function sqlLiteral(kind: DbKind, value: Value): string {
  switch (value.t) {
    case 'null':
      return 'NULL';
    case 'bool':
      return kind === 'mssql' || kind === 'sqlite' ? (value.v ? '1' : '0') : value.v ? 'TRUE' : 'FALSE';
    case 'int':
      return /^-?\d+$/.test(value.v) ? value.v : quoteString(kind, value.v);
    case 'decimal':
      return NUMERIC_TEXT.test(value.v) ? value.v : quoteString(kind, value.v);
    case 'float':
      if (Number.isFinite(value.v)) return String(value.v);
      return kind === 'postgres' ? `'${Number.isNaN(value.v) ? 'NaN' : value.v > 0 ? 'Infinity' : '-Infinity'}'::float8` : quoteString(kind, String(value.v));
    case 'text':
      return quoteString(kind, value.v);
    case 'datetime':
      return quoteString(kind, kind === 'mssql' ? mssqlDateTimeText(value.v) : value.v);
    case 'json':
      return quoteString(kind, typeof value.v === 'string' ? value.v : JSON.stringify(value.v));
    case 'bytes': {
      const hex = value.hex.toLowerCase();
      switch (kind) {
        case 'postgres':
          return `'\\x${hex}'::bytea`;
        case 'mssql':
          return `0x${hex}`;
        default:
          return `X'${hex}'`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Editable result detection
// ---------------------------------------------------------------------------

export interface SelectTarget {
  /** Schema as written (undefined when the table was not qualified). */
  schema?: string;
  table: string;
}

const SELECT_DISQUALIFIERS = new Set(['join', 'union', 'intersect', 'except', 'minus', 'group', 'having', 'distinct', 'into', 'window', 'pivot', 'unpivot', 'apply']);
const AGGREGATES = new Set([
  'count', 'count_big', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg', 'json_agg', 'jsonb_agg', 'json_object_agg',
  'jsonb_object_agg', 'group_concat', 'bool_and', 'bool_or', 'every', 'stddev', 'stddev_pop', 'stddev_samp', 'variance',
  'var_pop', 'var_samp', 'var', 'varp', 'stdev', 'stdevp', 'listagg', 'xmlagg', 'total', 'json_group_array', 'json_group_object',
  'bit_and', 'bit_or', 'bit_xor', 'checksum_agg', 'grouping'
]);

/** Keywords that end a FROM clause. */
const FROM_CLAUSE_END = new Set(['where', 'order', 'limit', 'offset', 'fetch', 'for', 'option', 'qualify', 'returning']);

function unquoteIdent(raw: string): string {
  const open = raw[0];
  const close = open === '[' ? ']' : open;
  const inner = raw.slice(1, raw.endsWith(close) && raw.length > 1 ? -1 : undefined);
  return inner.split(close + close).join(close);
}

/**
 * If `sql` is a single plain SELECT from exactly one table (no joins,
 * set operations, grouping, DISTINCT, aggregates, or INTO at the top level),
 * the table it reads. Powers editable query results. Unquoted names are
 * folded to lower case for Postgres, which is how the server resolves them.
 */
export function singleSelectTarget(sql: string, kind?: DbKind): SelectTarget | null {
  const stmts = splitStatements(sql, kind);
  if (stmts.length !== 1) return null;
  const text = stmts[0].text;
  const toks = lex(text, kind).filter(isSignificant);
  const first = toks[0];
  if (!first || first.type !== 'word' || text.slice(first.start, first.end).toLowerCase() !== 'select') return null;

  let depth = 0;
  let fromIdx = -1;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'punct') {
      const ch = text[t.start];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      continue;
    }
    if (depth !== 0 || t.type !== 'word') continue;
    const w = text.slice(t.start, t.end).toLowerCase();
    if (SELECT_DISQUALIFIERS.has(w)) return null;
    const next = toks[k + 1];
    if (fromIdx === -1 && AGGREGATES.has(w) && next && next.type === 'punct' && text[next.start] === '(') return null;
    if (w === 'from' && fromIdx === -1) fromIdx = k;
  }
  if (fromIdx === -1) return null;

  const parts: { name: string; quoted: boolean }[] = [];
  let j = fromIdx + 1;
  if (kind !== 'mssql' && toks[j]?.type === 'word' && text.slice(toks[j].start, toks[j].end).toLowerCase() === 'only') j++;
  for (;;) {
    const t = toks[j];
    if (!t) return null;
    if (t.type === 'word') parts.push({ name: text.slice(t.start, t.end), quoted: false });
    else if (t.type === 'qident' || (t.type === 'string' && kind === 'mysql' && text[t.start] === '"')) parts.push({ name: unquoteIdent(text.slice(t.start, t.end)), quoted: true });
    else return null;
    j++;
    const dot = toks[j];
    if (dot && dot.type === 'punct' && text[dot.start] === '.') {
      j++;
      continue;
    }
    break;
  }
  // A top-level comma before the next clause means an implicit join (`FROM a, b` or `FROM a x, b`).
  for (let k = j, level = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'punct') {
      const ch = text[t.start];
      if (ch === '(') level++;
      else if (ch === ')') level--;
      else if (ch === ',' && level === 0) return null;
      continue;
    }
    if (level === 0 && t.type === 'word' && FROM_CLAUSE_END.has(text.slice(t.start, t.end).toLowerCase())) break;
  }
  const norm = (p: { name: string; quoted: boolean }) => (kind === 'postgres' && !p.quoted ? p.name.toLowerCase() : p.name);
  if (parts.length === 1) return { table: norm(parts[0]) };
  if (parts.length === 2) return { schema: norm(parts[0]), table: norm(parts[1]) };
  return null;
}
