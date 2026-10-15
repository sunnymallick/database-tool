/**
 * Minimal SQL tokenizer for coloring SQL in AI cards and code blocks.
 * Display only: it never needs to be a correct parser.
 */
export type SqlTokenKind = 'kw' | 'fn' | 'str' | 'num' | 'com' | 'quoted' | 'op' | 'text';

export interface SqlToken {
  k: SqlTokenKind;
  v: string;
}

const KEYWORDS = new Set(
  `select from where and or not in is null like ilike between exists case when then else end as on join inner left right full outer cross
  natural using group by order having limit offset fetch next rows only top distinct all any some union intersect except with recursive
  insert into values update set delete merge matched create alter drop truncate table view index unique primary key foreign references
  constraint default check if begin commit rollback transaction returning asc desc nulls first last over partition window filter
  materialized schema database grant revoke cascade restrict explain analyze show describe pragma true false interval cast collate
  lateral apply pivot unpivot go declare exec execute procedure function returns language replace temporary temp`
    .split(/\s+/)
    .filter(Boolean)
);

const FUNCTIONS = new Set(
  `count sum avg min max coalesce nullif isnull ifnull round floor ceil ceiling abs length len lower upper trim ltrim rtrim substring substr
  concat date_trunc date_part extract now current_date current_timestamp getdate sysdatetime dateadd datediff datefromparts strftime
  date datetime julianday to_char to_date format year month day row_number rank dense_rank lag lead first_value last_value string_agg
  group_concat array_agg json_agg json_extract jsonb_build_object cast convert`
    .split(/\s+/)
    .filter(Boolean)
);

export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  const push = (k: SqlTokenKind, v: string) => {
    const last = out[out.length - 1];
    if (last && last.k === k && (k === 'text' || k === 'op')) last.v += v;
    else out.push({ k, v });
  };
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^--[^\n]*/.exec(rest)) || (m = /^\/\*[\s\S]*?(\*\/|$)/.exec(rest))) {
      push('com', m[0]);
    } else if ((m = /^'(?:[^']|'')*'?/.exec(rest))) {
      push('str', m[0]);
    } else if ((m = /^("(?:[^"]|"")*"?|`[^`]*`?|\[[^\]\n]*\]?)/.exec(rest))) {
      push('quoted', m[0]);
    } else if ((m = /^\d+(\.\d+)?([eE][-+]?\d+)?\b/.exec(rest))) {
      push('num', m[0]);
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest))) {
      const w = m[0].toLowerCase();
      const isCall = /^\s*\(/.test(sql.slice(i + m[0].length));
      push(KEYWORDS.has(w) && !(isCall && FUNCTIONS.has(w)) ? 'kw' : isCall && FUNCTIONS.has(w) ? 'fn' : 'text', m[0]);
    } else if ((m = /^[-+*/%<>=!|&^~:;,.()]+/.exec(rest))) {
      push('op', m[0]);
    } else {
      m = /^[\s\S]/.exec(rest)!;
      push('text', m[0]);
    }
    i += m[0].length;
  }
  return out;
}
