/**
 * SQL Server catalog queries over sys.* views (SQL Server 2012+ / Azure SQL).
 * Each call is one parameterized request; multi-part lookups are a single
 * batch returning several recordsets to save round trips.
 */
import sql from 'mssql';
import { qualifiedName } from '@shared/sql';
import type { CheckInfo, ColumnInfo, DbMeta, ForeignKeyInfo, IndexInfo, RoutineInfo, RoutineKind, SchemaList, TableInfo, TableKind, TableStructure } from '@shared/types';
import { AppError } from '../errors';
import { mssqlCreateTableDdl, type MssqlColumnDef, type MssqlIndexDef } from './mssql-ddl';
import { renderMssqlType } from './mssql-values';

type Row = Record<string, unknown>;

async function run(pool: sql.ConnectionPool, text: string, params: Record<string, string | number> = {}): Promise<Row[][]> {
  const req = pool.request();
  for (const [name, value] of Object.entries(params)) req.input(name, typeof value === 'number' ? sql.Int : sql.NVarChar(sql.MAX), value);
  const res = await req.query(text);
  return res.recordsets as unknown as Row[][];
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const bool = (v: unknown): boolean => v === true || v === 1 || v === '1';
const objectType = (v: unknown): string => str(v).trim();
const kindOf = (type: string): TableKind => (type === 'V' ? 'view' : 'table');

/** Every database this login can open. */
export async function listDatabases(pool: sql.ConnectionPool): Promise<string[]> {
  const [r] = await run(pool, 'SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name');
  return r.map((x) => str(x.name));
}

export async function listSchemas(pool: sql.ConnectionPool): Promise<SchemaList> {
  const [schemas, current] = await run(
    pool,
    `SELECT s.name FROM sys.schemas s
     -- 16384-16393 are the fixed database-role schemas (db_owner, ...); a user schema may still be called db_x.
     WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest') AND s.schema_id NOT BETWEEN 16384 AND 16399
     ORDER BY s.name;
     SELECT SCHEMA_NAME() AS def;`
  );
  return { schemas: schemas.map((x) => str(x.name)), defaultSchema: str(current[0]?.def) || 'dbo' };
}

const TABLE_INFO_COLUMNS = `CAST(ep.value AS nvarchar(4000)) AS comment,
       (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS estimate`;
const TABLE_COMMENT_JOIN = `LEFT JOIN sys.extended_properties ep
  ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'`;

export async function listTables(pool: sql.ConnectionPool, schema: string): Promise<TableInfo[]> {
  const [r] = await run(
    pool,
    `SELECT o.name, o.type, ${TABLE_INFO_COLUMNS}
     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
     ${TABLE_COMMENT_JOIN}
     WHERE s.name = @schema AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
     ORDER BY o.name`,
    { schema }
  );
  return r.map((x) => {
    const kind = kindOf(objectType(x.type));
    const info: TableInfo = { schema, name: str(x.name), kind };
    if (x.comment) info.comment = str(x.comment);
    if (x.estimate !== null && x.estimate !== undefined) info.rowEstimate = Number(x.estimate);
    return info;
  });
}

export async function listRoutines(pool: sql.ConnectionPool, schema: string): Promise<RoutineInfo[]> {
  const [r] = await run(
    pool,
    `SELECT o.name, o.type,
            STUFF((SELECT N', ' + p.name + N' ' + TYPE_NAME(p.user_type_id) + CASE WHEN p.is_output = 1 THEN N' OUTPUT' ELSE N'' END
                   FROM sys.parameters p WHERE p.object_id = o.object_id AND p.parameter_id > 0
                   ORDER BY p.parameter_id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, N'') AS args,
            (SELECT TYPE_NAME(p.user_type_id) FROM sys.parameters p WHERE p.object_id = o.object_id AND p.parameter_id = 0) AS returns
     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE s.name = @schema AND o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT') AND o.is_ms_shipped = 0
     ORDER BY o.name`,
    { schema }
  );
  return r.map((x) => {
    const type = objectType(x.type);
    const kind: RoutineKind = type === 'P' || type === 'PC' ? 'procedure' : 'function';
    const info: RoutineInfo = { schema, name: str(x.name), kind, signature: `(${str(x.args)})` };
    if (kind === 'function') info.returns = type === 'IF' || type === 'TF' || type === 'FT' ? 'TABLE' : str(x.returns) || undefined;
    if (info.returns === undefined) delete info.returns;
    return info;
  });
}

export async function primaryKey(pool: sql.ConnectionPool, schema: string, table: string): Promise<string[]> {
  const [r] = await run(
    pool,
    `SELECT c.name FROM sys.indexes i
     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE i.object_id = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@table)) AND i.is_primary_key = 1
     ORDER BY ic.key_ordinal`,
    { schema, table }
  );
  return r.map((x) => str(x.name));
}

/** Everything about one table in a single batch: object, columns, indexes, foreign keys (both ways), checks. */
async function tableFacts(pool: sql.ConnectionPool, schema: string, table: string) {
  const [obj, cols, idx, fks, checks] = await run(
    pool,
    `DECLARE @oid int = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@table));
     SELECT o.type, ${TABLE_INFO_COLUMNS}
     FROM sys.objects o ${TABLE_COMMENT_JOIN}
     WHERE o.object_id = @oid AND o.type IN ('U', 'V');

     SELECT c.column_id AS ordinal, c.name, ty.name AS type, ty.is_user_defined AS user_type,
            c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed,
            dc.name AS default_name, dc.definition AS default_def,
            cc.definition AS computed_def, cc.is_persisted,
            CAST(idc.seed_value AS nvarchar(40)) AS seed, CAST(idc.increment_value AS nvarchar(40)) AS increment,
            CAST(ep.value AS nvarchar(4000)) AS comment
     FROM sys.columns c
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
     LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
     LEFT JOIN sys.identity_columns idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id
     LEFT JOIN sys.extended_properties ep
       ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description'
     WHERE c.object_id = @oid
     ORDER BY c.column_id;

     SELECT i.name, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.filter_definition,
            c.name AS col, ic.is_descending_key, ic.is_included_column
     FROM sys.indexes i
     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     -- key_ordinal 0 without INCLUDE marks partitioning or columnstore columns, not keys.
     WHERE i.object_id = @oid AND i.type > 0 AND i.is_hypothetical = 0 AND (ic.key_ordinal > 0 OR ic.is_included_column = 1)
     ORDER BY i.is_primary_key DESC, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id;

     SELECT fk.name, OBJECT_SCHEMA_NAME(fk.parent_object_id) AS owner_schema, OBJECT_NAME(fk.parent_object_id) AS owner_table,
            pc.name AS col, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ref_schema,
            OBJECT_NAME(fk.referenced_object_id) AS ref_table, rc.name AS ref_col,
            fk.update_referential_action_desc AS on_update, fk.delete_referential_action_desc AS on_delete,
            CASE WHEN fk.parent_object_id = @oid THEN 1 ELSE 0 END AS is_out,
            CASE WHEN fk.referenced_object_id = @oid THEN 1 ELSE 0 END AS is_in
     FROM sys.foreign_keys fk
     JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
     JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
     JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
     WHERE fk.parent_object_id = @oid OR fk.referenced_object_id = @oid
     ORDER BY owner_schema, owner_table, fk.name, fkc.constraint_column_id;

     SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = @oid ORDER BY name;`,
    { schema, table }
  );
  if (!obj || obj.length === 0) throw new AppError(`Table ${schema}.${table} was not found`, 'NOT_FOUND');
  return { obj: obj[0], cols, idx, fks, checks };
}

function columnType(c: Row): string {
  if (bool(c.user_type)) return str(c.type);
  return renderMssqlType(str(c.type), Number(c.max_length), Number(c.precision), Number(c.scale));
}

function groupIndexes(rows: Row[]): MssqlIndexDef[] {
  const out: MssqlIndexDef[] = [];
  for (const r of rows) {
    const name = str(r.name);
    let idx = out[out.length - 1];
    if (!idx || idx.name !== name) {
      idx = {
        name,
        typeDesc: str(r.type_desc),
        unique: bool(r.is_unique),
        primary: bool(r.is_primary_key),
        uniqueConstraint: bool(r.is_unique_constraint),
        columns: [],
        included: [],
        filter: r.filter_definition ? str(r.filter_definition) : null
      };
      out.push(idx);
    }
    if (bool(r.is_included_column)) idx.included.push(str(r.col));
    else idx.columns.push({ name: str(r.col), desc: bool(r.is_descending_key) });
  }
  return out;
}

function groupForeignKeys(rows: Row[]): (ForeignKeyInfo & { out: boolean; in: boolean })[] {
  const out: (ForeignKeyInfo & { out: boolean; in: boolean })[] = [];
  for (const r of rows) {
    const name = str(r.name);
    const schema = str(r.owner_schema);
    const table = str(r.owner_table);
    const last = out[out.length - 1];
    if (last && last.name === name && last.schema === schema && last.table === table) {
      last.columns.push(str(r.col));
      last.refColumns.push(str(r.ref_col));
      continue;
    }
    out.push({
      name,
      schema,
      table,
      columns: [str(r.col)],
      refSchema: str(r.ref_schema),
      refTable: str(r.ref_table),
      refColumns: [str(r.ref_col)],
      onUpdate: str(r.on_update).replace(/_/g, ' '),
      onDelete: str(r.on_delete).replace(/_/g, ' '),
      out: bool(r.is_out),
      in: bool(r.is_in)
    });
  }
  return out;
}

/** CHECK definitions come wrapped in one pair of parentheses. */
function stripOuterParens(def: string): string {
  const t = def.trim();
  return t.startsWith('(') && t.endsWith(')') ? t.slice(1, -1) : t;
}

export async function describeTable(pool: sql.ConnectionPool, schema: string, table: string): Promise<TableStructure> {
  const f = await tableFacts(pool, schema, table);
  const indexes = groupIndexes(f.idx);
  const pk = indexes.find((i) => i.primary)?.columns.map((c) => c.name) ?? [];
  const fks = groupForeignKeys(f.fks);
  const columns: ColumnInfo[] = f.cols.map((c) => {
    const info: ColumnInfo = {
      name: str(c.name),
      type: columnType(c),
      nullable: bool(c.is_nullable),
      defaultValue: c.default_def ? str(c.default_def) : c.computed_def ? str(c.computed_def) : null,
      isPrimaryKey: pk.includes(str(c.name)),
      isIdentity: bool(c.is_identity),
      ordinal: Number(c.ordinal)
    };
    if (bool(c.is_computed)) info.isGenerated = true;
    if (c.comment) info.comment = str(c.comment);
    return info;
  });
  const structure: TableStructure = {
    schema,
    name: table,
    kind: kindOf(objectType(f.obj.type)),
    columns,
    primaryKey: pk,
    indexes: indexes.map(
      (i): IndexInfo => ({
        name: i.name,
        columns: i.columns.map((c) => c.name),
        unique: i.unique,
        primary: i.primary,
        method: i.typeDesc,
        ...(i.filter ? { definition: `WHERE ${i.filter}` } : {})
      })
    ),
    foreignKeys: fks.filter((k) => k.out).map(({ out: _o, in: _i, ...fk }) => fk),
    referencedBy: fks.filter((k) => k.in).map(({ out: _o, in: _i, ...fk }) => fk),
    checks: f.checks.map((c): CheckInfo => ({ name: str(c.name), definition: stripOuterParens(str(c.definition)) }))
  };
  if (f.obj.comment) structure.comment = str(f.obj.comment);
  if (f.obj.estimate !== null && f.obj.estimate !== undefined) structure.rowEstimate = Number(f.obj.estimate);
  return structure;
}

export async function tableDdl(pool: sql.ConnectionPool, schema: string, table: string): Promise<string> {
  const f = await tableFacts(pool, schema, table);
  if (objectType(f.obj.type) === 'V') {
    const [r] = await run(pool, `SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@table))) AS def`, { schema, table });
    const def = str(r[0]?.def).trim();
    if (!def) throw new AppError(`The definition of ${schema}.${table} is not visible (encrypted, or missing VIEW DEFINITION permission)`, 'NOT_FOUND');
    return `${def}\n`;
  }
  const columns: MssqlColumnDef[] = f.cols.map((c) => {
    const def: MssqlColumnDef = { name: str(c.name), type: columnType(c), nullable: bool(c.is_nullable) };
    if (bool(c.is_identity)) def.identity = { seed: str(c.seed) || '1', increment: str(c.increment) || '1' };
    if (bool(c.is_computed) && c.computed_def) def.computed = { definition: str(c.computed_def), persisted: bool(c.is_persisted) };
    if (c.default_def) def.defaultConstraint = { name: c.default_name ? str(c.default_name) : null, definition: str(c.default_def) };
    if (c.comment) def.comment = str(c.comment);
    return def;
  });
  return mssqlCreateTableDdl({
    schema,
    name: table,
    columns,
    indexes: groupIndexes(f.idx),
    foreignKeys: groupForeignKeys(f.fks)
      .filter((k) => k.out)
      .map((k) => ({ name: k.name, columns: k.columns, refSchema: k.refSchema, refTable: k.refTable, refColumns: k.refColumns, onDelete: k.onDelete ?? '', onUpdate: k.onUpdate ?? '' })),
    checks: f.checks.map((c) => ({ name: str(c.name), definition: str(c.definition) })),
    ...(f.obj.comment ? { comment: str(f.obj.comment) } : {})
  });
}

export async function routineDefinition(pool: sql.ConnectionPool, schema: string, name: string, _kind: RoutineKind): Promise<string> {
  const [r] = await run(pool, `SELECT OBJECT_DEFINITION(OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@name))) AS def`, { schema, name });
  const def = str(r[0]?.def).trim();
  if (!def) throw new AppError(`The definition of ${qualifiedName('mssql', schema, name)} is not visible (encrypted, or missing VIEW DEFINITION permission)`, 'NOT_FOUND');
  return `${def}\n`;
}

export async function fetchMeta(pool: sql.ConnectionPool, maxTables: number): Promise<DbMeta> {
  const schemas = await listSchemas(pool);
  const topTables = `SELECT TOP (@max) o.object_id
     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
     ORDER BY CASE WHEN s.name = SCHEMA_NAME() THEN 0 ELSE 1 END, s.name, o.name`;
  const [tables, cols] = await run(
    pool,
    `SELECT TOP (@max) o.object_id AS id, s.name AS schema_name, o.name, o.type
     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
     ORDER BY CASE WHEN s.name = SCHEMA_NAME() THEN 0 ELSE 1 END, s.name, o.name;
     SELECT c.object_id AS id, c.name, TYPE_NAME(c.user_type_id) AS type
     FROM sys.columns c WHERE c.object_id IN (${topTables})
     ORDER BY c.object_id, c.column_id;`,
    { max: maxTables + 1 }
  );
  const truncated = tables.length > maxTables;
  const byId = new Map<number, DbMeta['tables'][number]>();
  const out = tables.slice(0, maxTables).map((t) => {
    const entry = { schema: str(t.schema_name), name: str(t.name), kind: kindOf(objectType(t.type)), columns: [] as { name: string; type: string }[] };
    byId.set(Number(t.id), entry);
    return entry;
  });
  for (const c of cols) byId.get(Number(c.id))?.columns.push({ name: str(c.name), type: str(c.type) });
  const meta: DbMeta = { defaultSchema: schemas.defaultSchema, schemas: schemas.schemas, tables: out };
  if (truncated) meta.truncated = true;
  return meta;
}
