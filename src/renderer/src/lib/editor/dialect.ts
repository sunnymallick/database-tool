/**
 * Engine -> editor dialect / formatter language mapping and SQL formatting.
 */
import { MSSQL, MySQL, PostgreSQL, SQLite, StandardSQL, type SQLDialect } from '@codemirror/lang-sql';
import { format, type SqlLanguage } from 'sql-formatter';
import type { DbKind } from '@shared/types';

export function cmDialect(kind: DbKind | null | undefined): SQLDialect {
  switch (kind) {
    case 'postgres':
      return PostgreSQL;
    case 'mysql':
      return MySQL;
    case 'mssql':
      return MSSQL;
    case 'sqlite':
      return SQLite;
    default:
      return StandardSQL;
  }
}

export function formatterLanguage(kind: DbKind | null | undefined): SqlLanguage {
  switch (kind) {
    case 'postgres':
      return 'postgresql';
    case 'mysql':
      return 'mysql';
    case 'mssql':
      return 'transactsql';
    case 'sqlite':
      return 'sqlite';
    default:
      return 'sql';
  }
}

/** Pretty-print SQL for the engine. Throws when the formatter cannot parse the input. */
export function formatSql(sql: string, kind: DbKind | null | undefined): string {
  return format(sql, {
    language: formatterLanguage(kind),
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1,
    paramTypes: { named: [':'] }
  });
}
