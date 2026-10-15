/**
 * Small SQL text builders for generated queries (identifiers are only quoted
 * when they need it, so generated SQL stays readable).
 */
import { quoteIdent } from '@shared/sql';
import { dbKindInfo, type DbKind, type Value } from '@shared/types';

const RESERVED = new Set(
  (
    'all and any as asc between by case check column constraint create cross current_date current_time current_user ' +
    'default delete desc distinct drop else end except exists false fetch for foreign from full grant group having ' +
    'in index inner insert intersect into is join key left like limit natural not null offset on or order outer ' +
    'primary references right select session_user set some table then to top true union unique update user using ' +
    'values view when where with'
  ).split(' ')
);

/** Quote an identifier only when required (case, characters, reserved words). */
export function ident(kind: DbKind, name: string): string {
  const simple = kind === 'postgres' || kind === 'sqlite' ? /^[a-z_][a-z0-9_]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
  return simple.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quoteIdent(kind, name);
}

/** `schema.table`, omitting SQLite's `main` schema. */
export function displayName(kind: DbKind, schemaName: string, table: string): string {
  if (!schemaName || (kind === 'sqlite' && schemaName === dbKindInfo('sqlite').defaultSchema)) return ident(kind, table);
  return `${ident(kind, schemaName)}.${ident(kind, table)}`;
}

/** `SELECT * FROM t LIMIT n` or `SELECT TOP n * FROM t` for SQL Server. */
export function selectTopSql(kind: DbKind, schemaName: string, table: string, n = 100): string {
  const name = displayName(kind, schemaName, table);
  return kind === 'mssql' ? `SELECT TOP ${n} *\nFROM ${name};` : `SELECT *\nFROM ${name}\nLIMIT ${n};`;
}

/** A WHERE condition matching one cell value, e.g. `status = 'paid'` or `notes IS NULL`. */
export function equalsCondition(kind: DbKind, column: string, v: Value): string {
  const col = ident(kind, column);
  switch (v.t) {
    case 'null':
      return `${col} IS NULL`;
    case 'bool':
      return kind === 'mssql' || kind === 'sqlite' ? `${col} = ${v.v ? 1 : 0}` : `${col} = ${v.v ? 'TRUE' : 'FALSE'}`;
    case 'int':
    case 'decimal':
      return `${col} = ${v.v}`;
    case 'float':
      return `${col} = ${v.v}`;
    case 'bytes':
      return kind === 'postgres' ? `${col} = '\\x${v.hex}'` : kind === 'sqlite' ? `${col} = X'${v.hex}'` : `${col} = 0x${v.hex}`;
    case 'json': {
      const text = typeof v.v === 'string' ? v.v : JSON.stringify(v.v);
      return `${col} = '${text.replace(/'/g, "''")}'`;
    }
    default:
      return `${col} = '${v.v.replace(/'/g, "''")}'`;
  }
}
