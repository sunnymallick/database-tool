/**
 * SQLite catalog: sqlite_schema plus the table-valued pragmas
 * (pragma_table_xinfo, pragma_index_list, pragma_foreign_key_list).
 * `schema` is an attached database name (`main`, `temp`, or an ATTACH alias).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { quoteIdent } from '@shared/sql';
import type { CheckInfo, ColumnInfo, DbMeta, ForeignKeyInfo, IndexInfo, SchemaList, TableInfo, TableKind, TableStructure } from '@shared/types';
import { AppError } from '../errors';

function all<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

const master = (schema: string) => `${quoteIdent('sqlite', schema)}.sqlite_schema`;
const kindOf = (type: string): TableKind => (type === 'view' ? 'view' : 'table');

export function listSchemas(db: DatabaseSync): SchemaList {
  const names = all<{ name: string }>(db, 'SELECT name FROM pragma_database_list ORDER BY seq').map((r) => r.name);
  // `temp` always exists; only show it once something has been created there.
  const schemas = names.filter((n) => n !== 'temp' || all<{ n: number }>(db, 'SELECT count(*) AS n FROM temp.sqlite_schema')[0].n > 0);
  return { schemas, defaultSchema: 'main' };
}

/** Row counts from sqlite_stat1 (written by ANALYZE); absent on most databases. */
function statRowCounts(db: DatabaseSync, schema: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const r of all<{ tbl: string; n: number }>(db, `SELECT tbl, MAX(CAST(stat AS INTEGER)) AS n FROM ${quoteIdent('sqlite', schema)}.sqlite_stat1 GROUP BY tbl`)) {
      out.set(r.tbl, Number(r.n));
    }
  } catch {
    // No sqlite_stat1 table: no estimates.
  }
  return out;
}

export function listTables(db: DatabaseSync, schema: string): TableInfo[] {
  const stats = statRowCounts(db, schema);
  return all<{ name: string; type: string }>(
    db,
    `SELECT name, type FROM ${master(schema)} WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`
  ).map((r) => {
    const info: TableInfo = { schema, name: r.name, kind: kindOf(r.type) };
    const est = stats.get(r.name);
    if (est !== undefined) info.rowEstimate = est;
    return info;
  });
}

function objectInfo(db: DatabaseSync, schema: string, table: string): { type: string; sql: string | null } {
  // SQLite resolves table names case-insensitively; so does this lookup.
  const row = all<{ type: string; sql: string | null }>(db, `SELECT type, sql FROM ${master(schema)} WHERE name = ? COLLATE NOCASE AND type IN ('table', 'view')`, table)[0];
  if (!row) throw new AppError(`Table ${schema}.${table} was not found`, 'NOT_FOUND');
  return row;
}

export function primaryKey(db: DatabaseSync, schema: string, table: string): string[] {
  return all<{ name: string; pk: number }>(db, 'SELECT name, pk FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', table, schema).map((r) => r.name);
}

/** Blank out strings, quoted identifiers, and comments (same length) so regexes only see code. */
function maskSql(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

function unquote(name: string): string {
  const open = name[0];
  if (open === '"' || open === '`') return name.slice(1, -1).split(open + open).join(open);
  if (open === '[') return name.slice(1, -1);
  return name;
}

/** CHECK constraints parsed from CREATE TABLE text (SQLite exposes them nowhere else). */
export function sqliteCheckConstraints(createSql: string): CheckInfo[] {
  const masked = maskSql(createSql);
  const out: CheckInfo[] = [];
  const re = /\bcheck\s*\(/gi;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '(') depth++;
      else if (masked[i] === ')' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close === -1) break;
    const named = /constraint\s+("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[\w$]+)\s*$/i.exec(createSql.slice(0, m.index));
    out.push({ name: named ? unquote(named[1]) : `check_${out.length + 1}`, definition: createSql.slice(open + 1, close).trim() });
    re.lastIndex = close + 1;
  }
  return out;
}

interface FkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

function groupForeignKeys(db: DatabaseSync, schema: string, owner: string, rows: FkRow[]): ForeignKeyInfo[] {
  const out: ForeignKeyInfo[] = [];
  let lastId: number | null = null;
  for (const r of rows) {
    if (r.id !== lastId) {
      out.push({ name: `fk_${owner}_${r.id}`, schema, table: owner, columns: [], refSchema: schema, refTable: r.table, refColumns: [], onUpdate: r.on_update, onDelete: r.on_delete });
      lastId = r.id;
    }
    const fk = out[out.length - 1];
    fk.columns.push(r.from);
    if (r.to) fk.refColumns.push(r.to);
  }
  // `to` is NULL when the key references the parent's primary key implicitly.
  for (const fk of out) if (fk.refColumns.length === 0) fk.refColumns = primaryKey(db, schema, fk.refTable);
  return out;
}

export function describeTable(db: DatabaseSync, schema: string, table: string): TableStructure {
  const obj = objectInfo(db, schema, table);
  const cols = all<{ cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number }>(
    db,
    'SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?, ?) WHERE hidden <> 1 ORDER BY cid',
    table,
    schema
  );
  const pk = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const autoincrement = /\bautoincrement\b/i.test(maskSql(obj.sql ?? ''));
  // A single INTEGER PRIMARY KEY aliases the rowid, so the engine assigns it.
  const rowidAlias = pk.length === 1 && cols.find((c) => c.name === pk[0])?.type.toUpperCase() === 'INTEGER';

  const columns: ColumnInfo[] = cols.map((c, i) => {
    const info: ColumnInfo = {
      name: c.name,
      type: c.type || 'ANY',
      nullable: c.notnull === 0 && c.pk === 0,
      defaultValue: c.dflt_value,
      isPrimaryKey: c.pk > 0,
      isIdentity: c.pk > 0 && (autoincrement || rowidAlias),
      ordinal: i + 1
    };
    if (c.hidden === 2 || c.hidden === 3) info.isGenerated = true;
    return info;
  });

  const indexes: IndexInfo[] = all<{ name: string; unique: number; origin: string }>(db, 'SELECT name, "unique", origin FROM pragma_index_list(?, ?)', table, schema).map((ix) => {
    const members = all<{ name: string | null }>(db, 'SELECT name FROM pragma_index_info(?, ?) ORDER BY seqno', ix.name, schema);
    const def = all<{ sql: string | null }>(db, `SELECT sql FROM ${master(schema)} WHERE type = 'index' AND name = ?`, ix.name)[0]?.sql;
    const info: IndexInfo = { name: ix.name, columns: members.map((m) => m.name ?? '(expression)'), unique: ix.unique === 1, primary: ix.origin === 'pk' };
    if (def) info.definition = def;
    return info;
  });

  const outgoing = groupForeignKeys(
    db,
    schema,
    table,
    all<FkRow>(db, 'SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', table, schema)
  );
  const incoming: ForeignKeyInfo[] = [];
  const owners = all<{ name: string }>(db, `SELECT name FROM ${master(schema)} WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`);
  for (const o of owners) {
    const rows = all<FkRow>(db, 'SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq', o.name, schema);
    incoming.push(...groupForeignKeys(db, schema, o.name, rows).filter((fk) => fk.refTable.toLowerCase() === table.toLowerCase()));
  }

  const structure: TableStructure = {
    schema,
    name: table,
    kind: kindOf(obj.type),
    columns,
    primaryKey: pk,
    indexes,
    foreignKeys: outgoing,
    referencedBy: incoming,
    checks: obj.type === 'table' && obj.sql ? sqliteCheckConstraints(obj.sql) : []
  };
  const est = statRowCounts(db, schema).get(table);
  if (est !== undefined) structure.rowEstimate = est;
  return structure;
}

/** The stored CREATE statements: the table or view, then its indexes and triggers. */
export function tableDdl(db: DatabaseSync, schema: string, table: string): string {
  objectInfo(db, schema, table);
  const rows = all<{ sql: string }>(
    db,
    `SELECT sql FROM ${master(schema)}
     WHERE sql IS NOT NULL AND ((name = ? COLLATE NOCASE AND type IN ('table', 'view')) OR (tbl_name = ? COLLATE NOCASE AND type IN ('index', 'trigger')))
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
    table,
    table
  );
  return rows.map((r) => `${r.sql.trim().replace(/;$/, '')};\n`).join('\n');
}

export function fetchMeta(db: DatabaseSync, maxTables: number): DbMeta {
  const { schemas, defaultSchema } = listSchemas(db);
  const tables: DbMeta['tables'] = [];
  let truncated = false;
  for (const schema of schemas) {
    for (const t of listTables(db, schema)) {
      if (tables.length >= maxTables) {
        truncated = true;
        break;
      }
      let columns: { name: string; type: string }[] = [];
      try {
        columns = all<{ name: string; type: string }>(db, 'SELECT name, type FROM pragma_table_info(?, ?) ORDER BY cid', t.name, schema);
      } catch {
        // A view over a dropped table cannot be described; list it without columns.
      }
      tables.push({ schema, name: t.name, kind: t.kind, columns });
    }
  }
  const meta: DbMeta = { defaultSchema, schemas, tables };
  if (truncated) meta.truncated = true;
  return meta;
}
