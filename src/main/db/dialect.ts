/**
 * Pure SQL builders for table paging and row edits, one code path for every
 * engine. Drivers execute what these return; tests assert the text.
 */
import { qualifiedName, quoteIdent, sqlLiteral } from '@shared/sql';
import type { DbKind, RowChangeSet, SortSpec, Value } from '@shared/types';
import { AppError } from '../errors';
import type { FetchRowsSpec } from './driver';

const MAX_PAGE = 100_000;

function checkPaging(limit: number, offset: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new AppError(`Page size must be between 1 and ${MAX_PAGE}`, 'BAD_REQUEST');
  if (!Number.isInteger(offset) || offset < 0) throw new AppError('Offset must be a non-negative integer', 'BAD_REQUEST');
}

/**
 * The user's raw WHERE body, wrapped in parentheses on their own lines so a
 * trailing `-- comment` or an OR cannot escape the clause. Trailing
 * semicolons are dropped (people paste them).
 */
export function whereClause(where: string | undefined): string {
  const body = (where ?? '').trim().replace(/;+\s*$/, '').trim();
  return body ? `\nWHERE (\n${body}\n)` : '';
}

/**
 * ORDER BY for a page: the requested sort, else the primary key (stable
 * paging). SQL Server's OFFSET/FETCH requires an ORDER BY, so tables without
 * a key get `(SELECT NULL)`.
 */
export function orderClause(kind: DbKind, orderBy: SortSpec[] | undefined, primaryKey: string[]): string {
  const cols = orderBy && orderBy.length > 0 ? orderBy : primaryKey.map((column) => ({ column, desc: false }));
  if (cols.length > 0) return `\nORDER BY ${cols.map((s) => `${quoteIdent(kind, s.column)} ${s.desc ? 'DESC' : 'ASC'}`).join(', ')}`;
  return kind === 'mssql' ? '\nORDER BY (SELECT NULL)' : '';
}

export function buildPageQuery(kind: DbKind, spec: FetchRowsSpec, primaryKey: string[]): string {
  checkPaging(spec.limit, spec.offset);
  const base = `SELECT * FROM ${qualifiedName(kind, spec.schema, spec.table)}${whereClause(spec.where)}${orderClause(kind, spec.orderBy, primaryKey)}`;
  if (kind === 'mssql') return `${base}\nOFFSET ${spec.offset} ROWS FETCH NEXT ${spec.limit} ROWS ONLY`;
  return `${base}\nLIMIT ${spec.limit} OFFSET ${spec.offset}`;
}

export function buildCountQuery(kind: DbKind, spec: Pick<FetchRowsSpec, 'schema' | 'table' | 'where'>): string {
  const count = kind === 'mssql' ? 'COUNT_BIG(*)' : 'COUNT(*)';
  return `SELECT ${count} AS total FROM ${qualifiedName(kind, spec.schema, spec.table)}${whereClause(spec.where)}`;
}

export type ChangeKind = 'update' | 'insert' | 'delete';

/** One row edit: parameterized SQL to execute plus the literal rendering shown to the user. */
export interface ChangeStatement {
  kind: ChangeKind;
  sql: string;
  params: Value[];
  preview: string;
  /** UPDATE/DELETE by primary key must touch exactly one row or the batch is rolled back. */
  expectOneRow: boolean;
}

function placeholder(kind: DbKind, n: number): string {
  switch (kind) {
    case 'postgres':
      return `$${n}`;
    case 'mssql':
      return `@p${n}`;
    default:
      return '?';
  }
}

/** Accumulates parameters; NULL is inlined so no engine has to guess a parameter type for it. */
class ParamList {
  readonly values: Value[] = [];
  constructor(private readonly kind: DbKind) {}

  add(v: Value): { sql: string; preview: string } {
    if (v.t === 'null') return { sql: 'NULL', preview: 'NULL' };
    if (v.t === 'bytes' && v.truncated) throw new AppError('Cannot write a truncated binary value (only a preview was loaded)', 'TRUNCATED_VALUE');
    this.values.push(v);
    return { sql: placeholder(this.kind, this.values.length), preview: sqlLiteral(this.kind, v) };
  }
}

function keyCondition(kind: DbKind, params: ParamList, pk: string[], key: Record<string, Value>): { sql: string; preview: string } {
  const parts = pk.map((col) => {
    const v = key[col];
    if (!v || v.t === 'null') throw new AppError(`Primary key column "${col}" has no value`, 'BAD_KEY');
    const p = params.add(v);
    const ident = quoteIdent(kind, col);
    return { sql: `${ident} = ${p.sql}`, preview: `${ident} = ${p.preview}` };
  });
  return { sql: parts.map((p) => p.sql).join(' AND '), preview: parts.map((p) => p.preview).join(' AND ') };
}

function checkKey(pk: string[], key: Record<string, Value>): void {
  const given = Object.keys(key);
  const same = given.length === pk.length && pk.every((c) => given.includes(c));
  if (!same) throw new AppError(`Rows must be identified by exactly the primary key (${pk.join(', ')})`, 'BAD_KEY');
}

/**
 * Build the statements for a change set in execution order: deletes, then
 * updates, then inserts (so a deleted key can be reused by an update or
 * insert in the same batch). Updates and deletes are keyed by the primary
 * key only; tables without one are refused.
 */
export function buildChangeStatements(kind: DbKind, schema: string, table: string, changes: RowChangeSet, primaryKey: string[]): ChangeStatement[] {
  const total = changes.updates.length + changes.inserts.length + changes.deletes.length;
  if (total > 0 && primaryKey.length === 0) {
    throw new AppError(`${table} has no primary key, so rows cannot be edited safely`, 'NO_PRIMARY_KEY');
  }
  const target = qualifiedName(kind, schema, table);
  const out: ChangeStatement[] = [];

  for (const key of changes.deletes) {
    checkKey(primaryKey, key);
    const params = new ParamList(kind);
    const where = keyCondition(kind, params, primaryKey, key);
    out.push({
      kind: 'delete',
      sql: `DELETE FROM ${target} WHERE ${where.sql}`,
      params: params.values,
      preview: `DELETE FROM ${target} WHERE ${where.preview}`,
      expectOneRow: true
    });
  }

  for (const update of changes.updates) {
    checkKey(primaryKey, update.pk);
    const cols = Object.keys(update.set);
    if (cols.length === 0) continue;
    const params = new ParamList(kind);
    const sets = cols.map((col) => {
      const p = params.add(update.set[col]);
      const ident = quoteIdent(kind, col);
      return { sql: `${ident} = ${p.sql}`, preview: `${ident} = ${p.preview}` };
    });
    const where = keyCondition(kind, params, primaryKey, update.pk);
    out.push({
      kind: 'update',
      sql: `UPDATE ${target} SET ${sets.map((s) => s.sql).join(', ')} WHERE ${where.sql}`,
      params: params.values,
      preview: `UPDATE ${target} SET ${sets.map((s) => s.preview).join(', ')} WHERE ${where.preview}`,
      expectOneRow: true
    });
  }

  for (const row of changes.inserts) {
    const cols = Object.keys(row);
    if (cols.length === 0) {
      const sql = kind === 'mysql' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES`;
      out.push({ kind: 'insert', sql, params: [], preview: sql, expectOneRow: false });
      continue;
    }
    const params = new ParamList(kind);
    const vals = cols.map((col) => params.add(row[col]));
    const colList = cols.map((c) => quoteIdent(kind, c)).join(', ');
    out.push({
      kind: 'insert',
      sql: `INSERT INTO ${target} (${colList}) VALUES (${vals.map((v) => v.sql).join(', ')})`,
      params: params.values,
      preview: `INSERT INTO ${target} (${colList}) VALUES (${vals.map((v) => v.preview).join(', ')})`,
      expectOneRow: false
    });
  }
  return out;
}

/** Error for an UPDATE/DELETE that did not touch exactly one row. */
export function rowMismatchError(stmt: ChangeStatement, affected: number): AppError {
  const what = affected === 0 ? 'matched no row (it may have been changed or deleted)' : `matched ${affected} rows`;
  return new AppError(`${stmt.kind === 'update' ? 'Update' : 'Delete'} ${what}; no changes were saved.\n${stmt.preview}`, 'ROW_MISMATCH');
}
