/**
 * MySQL/MariaDB catalog queries over information_schema. In MySQL a schema
 * IS a database, so `schema` arguments are database names. Every column is
 * aliased in lower case (MySQL 8 returns information_schema names upper-case).
 */
import type { Pool as PromisePool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { quoteIdent } from '@shared/sql';
import type { CheckInfo, ColumnInfo, DbMeta, ForeignKeyInfo, IndexInfo, RoutineInfo, RoutineKind, SchemaList, TableInfo, TableKind, TableStructure } from '@shared/types';
import { AppError } from '../errors';

const SYSTEM_SCHEMAS = `('information_schema', 'mysql', 'performance_schema', 'sys')`;

type Row = RowDataPacket & Record<string, unknown>;

async function rows(db: PromisePool, sql: string, params: unknown[] = []): Promise<Row[]> {
  const [result] = await db.query<Row[]>(sql, params);
  return result;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const optStr = (v: unknown): string | undefined => {
  const s = str(v);
  return s === '' ? undefined : s;
};

function tableKind(type: string): TableKind {
  return /VIEW/i.test(type) ? 'view' : 'table';
}

export async function listDatabases(db: PromisePool): Promise<string[]> {
  const r = await rows(db, `SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name NOT IN ${SYSTEM_SCHEMAS} ORDER BY schema_name`);
  return r.map((x) => str(x.name));
}

export async function listSchemas(db: PromisePool): Promise<SchemaList> {
  const [schemas, current] = await Promise.all([listDatabases(db), rows(db, 'SELECT DATABASE() AS db')]);
  return { schemas, defaultSchema: str(current[0]?.db) };
}

export async function listTables(db: PromisePool, schema: string): Promise<TableInfo[]> {
  const r = await rows(
    db,
    `SELECT table_name AS name, table_type AS type, table_comment AS comment, table_rows AS estimate
     FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
    [schema]
  );
  return r.map((x) => {
    const kind = tableKind(str(x.type));
    const info: TableInfo = { schema, name: str(x.name), kind };
    const comment = str(x.comment);
    if (comment && !(kind === 'view' && comment === 'VIEW')) info.comment = comment;
    // InnoDB's table_rows is an estimate, which is all the sidebar needs.
    if (kind === 'table' && x.estimate !== null && x.estimate !== undefined) info.rowEstimate = Number(x.estimate);
    return info;
  });
}

export async function listRoutines(db: PromisePool, schema: string): Promise<RoutineInfo[]> {
  const r = await rows(
    db,
    `SELECT r.routine_name AS name, r.routine_type AS type, r.dtd_identifier AS returns,
            (SELECT GROUP_CONCAT(CONCAT_WS(' ', p.parameter_mode, p.parameter_name, p.dtd_identifier)
                                 ORDER BY p.ordinal_position SEPARATOR ', ')
             FROM information_schema.parameters p
             WHERE p.specific_schema = r.routine_schema AND p.specific_name = r.specific_name AND p.ordinal_position > 0) AS args
     FROM information_schema.routines r
     WHERE r.routine_schema = ?
     ORDER BY r.routine_name`,
    [schema]
  );
  return r.map((x) => {
    const kind: RoutineKind = /procedure/i.test(str(x.type)) ? 'procedure' : 'function';
    const info: RoutineInfo = { schema, name: str(x.name), kind, signature: `(${str(x.args)})` };
    const ret = optStr(x.returns);
    if (kind === 'function' && ret) info.returns = ret;
    return info;
  });
}

export async function primaryKey(db: PromisePool, schema: string, table: string): Promise<string[]> {
  const r = await rows(
    db,
    `SELECT column_name AS name FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND index_name = 'PRIMARY' ORDER BY seq_in_index`,
    [schema, table]
  );
  return r.map((x) => str(x.name));
}

function groupForeignKeys(r: Row[], ownerSchema: (x: Row) => string, ownerTable: (x: Row) => string): ForeignKeyInfo[] {
  const out: ForeignKeyInfo[] = [];
  for (const x of r) {
    const name = str(x.name);
    const schema = ownerSchema(x);
    const table = ownerTable(x);
    const last = out[out.length - 1];
    if (last && last.name === name && last.schema === schema && last.table === table) {
      last.columns.push(str(x.col));
      last.refColumns.push(str(x.ref_col));
      continue;
    }
    out.push({
      name,
      schema,
      table,
      columns: [str(x.col)],
      refSchema: str(x.ref_schema),
      refTable: str(x.ref_table),
      refColumns: [str(x.ref_col)],
      onUpdate: str(x.on_update),
      onDelete: str(x.on_delete)
    });
  }
  return out;
}

/**
 * CHECK constraints (MySQL 8.0.16+, MariaDB 10.2+; older servers have none).
 * MariaDB names them per table and exposes check_constraints.table_name, so
 * that query runs first; MySQL lacks the column and falls back to joining on
 * the schema-unique name.
 */
async function checkConstraints(db: PromisePool, schema: string, table: string): Promise<Row[]> {
  const mariadb = `SELECT constraint_name AS name, check_clause AS def FROM information_schema.check_constraints
                   WHERE constraint_schema = ? AND table_name = ? ORDER BY constraint_name`;
  const mysqlQuery = `SELECT tc.constraint_name AS name, cc.check_clause AS def
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_schema = tc.table_schema AND cc.constraint_name = tc.constraint_name
       WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'CHECK'
       ORDER BY tc.constraint_name`;
  try {
    return await rows(db, mariadb, [schema, table]);
  } catch {
    return rows(db, mysqlQuery, [schema, table]).catch(() => [] as Row[]);
  }
}

export async function describeTable(db: PromisePool, schema: string, table: string): Promise<TableStructure> {
  const info = await rows(
    db,
    `SELECT table_type AS type, table_comment AS comment, table_rows AS estimate
     FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
    [schema, table]
  );
  if (info.length === 0) throw new AppError(`Table ${schema}.${table} was not found`, 'NOT_FOUND');
  const kind = tableKind(str(info[0].type));

  const [cols, pk, idx, outgoing, incoming, chk] = await Promise.all([
    rows(
      db,
      `SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS def, extra,
              column_comment AS comment, ordinal_position AS ord, generation_expression AS gen
       FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [schema, table]
    ),
    primaryKey(db, schema, table),
    rows(
      db,
      `SELECT index_name AS name, non_unique AS non_unique, column_name AS col, index_type AS method
       FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?
       ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index`,
      [schema, table]
    ),
    rows(
      db,
      `SELECT kcu.constraint_name AS name, kcu.column_name AS col, kcu.referenced_table_schema AS ref_schema,
              kcu.referenced_table_name AS ref_table, kcu.referenced_column_name AS ref_col,
              rc.update_rule AS on_update, rc.delete_rule AS on_delete
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = kcu.constraint_schema AND rc.constraint_name = kcu.constraint_name
       WHERE kcu.table_schema = ? AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL
       ORDER BY kcu.constraint_name, kcu.ordinal_position`,
      [schema, table]
    ),
    rows(
      db,
      `SELECT kcu.constraint_name AS name, kcu.table_schema AS owner_schema, kcu.table_name AS owner_table,
              kcu.column_name AS col, kcu.referenced_table_schema AS ref_schema, kcu.referenced_table_name AS ref_table,
              kcu.referenced_column_name AS ref_col, rc.update_rule AS on_update, rc.delete_rule AS on_delete
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = kcu.constraint_schema AND rc.constraint_name = kcu.constraint_name
       WHERE kcu.referenced_table_schema = ? AND kcu.referenced_table_name = ?
       ORDER BY kcu.table_schema, kcu.table_name, kcu.constraint_name, kcu.ordinal_position`,
      [schema, table]
    ),
    checkConstraints(db, schema, table)
  ]);

  const columns: ColumnInfo[] = cols.map((c) => {
    const extra = str(c.extra).toLowerCase();
    const generated = /generated/.test(extra) && !/default_generated/.test(extra);
    const col: ColumnInfo = {
      name: str(c.name),
      type: str(c.type),
      nullable: str(c.nullable) === 'YES',
      defaultValue: generated ? optStr(c.gen) ?? null : c.def === null || c.def === undefined ? null : str(c.def),
      isPrimaryKey: pk.includes(str(c.name)),
      isIdentity: extra.includes('auto_increment'),
      ordinal: Number(c.ord)
    };
    if (generated) col.isGenerated = true;
    const comment = optStr(c.comment);
    if (comment) col.comment = comment;
    return col;
  });

  const indexes: IndexInfo[] = [];
  for (const x of idx) {
    const name = str(x.name);
    const col = x.col === null || x.col === undefined ? '(expression)' : str(x.col);
    const last = indexes[indexes.length - 1];
    if (last && last.name === name) last.columns.push(col);
    else indexes.push({ name, columns: [col], unique: Number(x.non_unique) === 0, primary: name === 'PRIMARY', method: str(x.method) });
  }

  const structure: TableStructure = {
    schema,
    name: table,
    kind,
    columns,
    primaryKey: pk,
    indexes,
    foreignKeys: groupForeignKeys(outgoing, () => schema, () => table),
    referencedBy: groupForeignKeys(incoming, (x) => str(x.owner_schema), (x) => str(x.owner_table)),
    checks: chk.map((x): CheckInfo => ({ name: str(x.name), definition: str(x.def) }))
  };
  const comment = str(info[0].comment);
  if (comment && !(kind === 'view' && comment === 'VIEW')) structure.comment = comment;
  if (kind === 'table' && info[0].estimate !== null && info[0].estimate !== undefined) structure.rowEstimate = Number(info[0].estimate);
  return structure;
}

/** SHOW CREATE TABLE / VIEW; the statement text is the second column. */
export async function tableDdl(db: PromisePool, schema: string, table: string): Promise<string> {
  const info = await rows(db, 'SELECT table_type AS type FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [schema, table]);
  if (info.length === 0) throw new AppError(`Table ${schema}.${table} was not found`, 'NOT_FOUND');
  const what = tableKind(str(info[0].type)) === 'view' ? 'VIEW' : 'TABLE';
  const [result] = await db.query<RowDataPacket[]>({ sql: `SHOW CREATE ${what} ${quoteIdent('mysql', schema)}.${quoteIdent('mysql', table)}`, rowsAsArray: true });
  const ddl = str((result[0] as unknown[] | undefined)?.[1]);
  if (!ddl) throw new AppError(`No definition available for ${schema}.${table}`, 'NOT_FOUND');
  return `${ddl};\n`;
}

/** SHOW CREATE PROCEDURE / FUNCTION; the definition is the third column (NULL without privileges). */
export async function routineDefinition(db: PromisePool, schema: string, name: string, kind: RoutineKind): Promise<string> {
  const what = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
  const [result] = await db.query<RowDataPacket[]>({ sql: `SHOW CREATE ${what} ${quoteIdent('mysql', schema)}.${quoteIdent('mysql', name)}`, rowsAsArray: true });
  const def = str((result[0] as unknown[] | undefined)?.[2]);
  if (!def) throw new AppError(`No definition visible for ${schema}.${name} (missing privileges?)`, 'NOT_FOUND');
  return `${def};\n`;
}

export async function fetchMeta(db: PromisePool, maxTables: number): Promise<DbMeta> {
  const schemas = await listSchemas(db);
  const tables = await rows(
    db,
    `SELECT table_schema AS s, table_name AS name, table_type AS type FROM information_schema.tables
     WHERE table_schema NOT IN ${SYSTEM_SCHEMAS}
     ORDER BY table_schema = DATABASE() DESC, table_schema, table_name
     LIMIT ?`,
    [maxTables + 1]
  );
  const truncated = tables.length > maxTables;
  const kept = tables.slice(0, maxTables);
  const byKey = new Map<string, DbMeta['tables'][number]>();
  const out = kept.map((t) => {
    const entry = { schema: str(t.s), name: str(t.name), kind: tableKind(str(t.type)), columns: [] as { name: string; type: string }[] };
    byKey.set(`${entry.schema}\u0000${entry.name}`, entry);
    return entry;
  });
  const inSchemas = [...new Set(out.map((t) => t.schema))];
  if (inSchemas.length > 0) {
    const cols = await rows(
      db,
      `SELECT table_schema AS s, table_name AS t, column_name AS name, column_type AS type
       FROM information_schema.columns WHERE table_schema IN (?) ORDER BY table_schema, table_name, ordinal_position`,
      [inSchemas]
    );
    for (const c of cols) byKey.get(`${str(c.s)}\u0000${str(c.t)}`)?.columns.push({ name: str(c.name), type: str(c.type) });
  }
  const meta: DbMeta = { defaultSchema: schemas.defaultSchema, schemas: schemas.schemas, tables: out };
  if (truncated) meta.truncated = true;
  return meta;
}
