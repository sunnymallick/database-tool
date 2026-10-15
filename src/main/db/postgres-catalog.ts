/**
 * Postgres catalog queries (pg_catalog, not information_schema: it is faster
 * and exposes identity, generated columns, matviews, and index definitions).
 * Run on the browsing pool with node-postgres' default type parsing.
 */
import type pg from 'pg';
import { quoteIdent } from '@shared/sql';
import type {
  CheckInfo,
  ColumnInfo,
  DbMeta,
  ForeignKeyInfo,
  IndexInfo,
  RoutineInfo,
  RoutineKind,
  SchemaList,
  TableInfo,
  TableKind,
  TableStructure
} from '@shared/types';
import { AppError } from '../errors';

type Queryable = Pick<pg.Pool, 'query'>;

const USER_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'`;
const RELKINDS = `('r', 'p', 'v', 'm', 'f')`;

export function relkindToTableKind(relkind: string): TableKind {
  if (relkind === 'v') return 'view';
  if (relkind === 'm') return 'materialized_view';
  return 'table';
}

const FK_ACTIONS: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

export async function listDatabases(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT datname AS name FROM pg_catalog.pg_database
     WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT')
     ORDER BY datname`
  );
  return rows.map((r) => r.name);
}

export async function listSchemas(db: Queryable): Promise<SchemaList> {
  const [schemas, current] = await Promise.all([
    db.query<{ name: string }>(
      `SELECT n.nspname AS name FROM pg_catalog.pg_namespace n
       WHERE ${USER_SCHEMA_FILTER} AND has_schema_privilege(n.oid, 'USAGE')
       ORDER BY n.nspname`
    ),
    db.query<{ schema: string | null }>('SELECT current_schema() AS schema')
  ]);
  const names = schemas.rows.map((r) => r.name);
  const def = current.rows[0]?.schema ?? (names.includes('public') ? 'public' : (names[0] ?? 'public'));
  return { schemas: names, defaultSchema: def };
}

export async function listTables(db: Queryable, schema: string): Promise<TableInfo[]> {
  const { rows } = await db.query<{ name: string; relkind: string; comment: string | null; estimate: number | null }>(
    `SELECT c.relname AS name, c.relkind AS relkind, obj_description(c.oid, 'pg_class') AS comment,
            c.reltuples::float8 AS estimate
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ${RELKINDS}
     ORDER BY c.relname`,
    [schema]
  );
  return rows.map((r) => {
    const kind = relkindToTableKind(r.relkind);
    const info: TableInfo = { schema, name: r.name, kind };
    if (r.comment) info.comment = r.comment;
    // reltuples is -1 (PG14+) before the first ANALYZE; views have no estimate.
    if (kind !== 'view' && r.estimate !== null && r.estimate >= 0) info.rowEstimate = Math.round(r.estimate);
    return info;
  });
}

export async function listRoutines(db: Queryable, schema: string): Promise<RoutineInfo[]> {
  const { rows } = await db.query<{ name: string; prokind: string; args: string; returns: string | null }>(
    `SELECT p.proname AS name, p.prokind AS prokind, pg_get_function_identity_arguments(p.oid) AS args,
            CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END AS returns
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
       -- Hide functions installed by extensions (pgcrypto & co. put dozens in public).
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                       WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     ORDER BY p.proname, args`,
    [schema]
  );
  return rows.map((r) => {
    const info: RoutineInfo = { schema, name: r.name, kind: r.prokind === 'p' ? 'procedure' : 'function', signature: `(${r.args})` };
    if (r.returns) info.returns = r.returns;
    return info;
  });
}

interface RelInfo {
  oid: number;
  relkind: string;
  comment: string | null;
  estimate: number | null;
  persistence: string;
}

async function relation(db: Queryable, schema: string, table: string): Promise<RelInfo> {
  const { rows } = await db.query<RelInfo>(
    `SELECT c.oid::int8::float8 AS oid, c.relkind AS relkind, obj_description(c.oid, 'pg_class') AS comment,
            c.reltuples::float8 AS estimate, c.relpersistence AS persistence
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ${RELKINDS}`,
    [schema, table]
  );
  if (rows.length === 0) throw new AppError(`Table ${schema}.${table} was not found`, 'NOT_FOUND');
  return rows[0];
}

interface ColumnRow {
  ordinal: number;
  name: string;
  type: string;
  notnull: boolean;
  default_expr: string | null;
  identity: string | null;
  generated: string | null;
  comment: string | null;
}

async function columnRows(db: Queryable, oid: number): Promise<ColumnRow[]> {
  // to_jsonb(a) reads attidentity/attgenerated without failing on servers that predate them.
  const { rows } = await db.query<ColumnRow>(
    `SELECT a.attnum AS ordinal, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default_expr,
            NULLIF(to_jsonb(a) ->> 'attidentity', '') AS identity,
            NULLIF(to_jsonb(a) ->> 'attgenerated', '') AS generated,
            col_description(a.attrelid, a.attnum) AS comment
     FROM pg_catalog.pg_attribute a
     LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [oid]
  );
  return rows;
}

export async function primaryKey(db: Queryable, schema: string, table: string): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT a.attname AS name
     FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'p'
     ORDER BY k.ord`,
    [schema, table]
  );
  return rows.map((r) => r.name);
}

async function indexes(db: Queryable, oid: number): Promise<IndexInfo[]> {
  const { rows } = await db.query<{ name: string; unique: boolean; primary: boolean; method: string; definition: string; columns: string[] }>(
    `SELECT ic.relname AS name, i.indisunique AS unique, i.indisprimary AS primary, am.amname AS method,
            pg_get_indexdef(i.indexrelid) AS definition,
            ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
                  FROM generate_series(1, COALESCE((to_jsonb(i) ->> 'indnkeyatts')::int, i.indnatts)) AS k
                  ORDER BY k)::text[] AS columns
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_catalog.pg_am am ON am.oid = ic.relam
     WHERE i.indrelid = $1::oid
     ORDER BY i.indisprimary DESC, ic.relname`,
    [oid]
  );
  return rows.map((r) => ({ name: r.name, columns: r.columns, unique: r.unique, primary: r.primary, method: r.method, definition: r.definition }));
}

async function foreignKeys(db: Queryable, oid: number): Promise<{ outgoing: ForeignKeyInfo[]; incoming: ForeignKeyInfo[] }> {
  const { rows } = await db.query<{
    name: string;
    owner_oid: number;
    schema: string;
    table: string;
    columns: string[];
    ref_schema: string;
    ref_table: string;
    ref_columns: string[];
    on_update: string;
    on_delete: string;
  }>(
    `SELECT c.conname AS name, c.conrelid::int8::float8 AS owner_oid, sn.nspname AS schema, sc.relname AS table,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(n, o)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS columns,
            rn.nspname AS ref_schema, rc.relname AS ref_table,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(n, o)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o) AS ref_columns,
            c.confupdtype AS on_update, c.confdeltype AS on_delete
     FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class sc ON sc.oid = c.conrelid JOIN pg_catalog.pg_namespace sn ON sn.oid = sc.relnamespace
     JOIN pg_catalog.pg_class rc ON rc.oid = c.confrelid JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
     WHERE c.contype = 'f' AND (c.conrelid = $1::oid OR c.confrelid = $1::oid)
     ORDER BY sn.nspname, sc.relname, c.conname`,
    [oid]
  );
  const outgoing: ForeignKeyInfo[] = [];
  const incoming: ForeignKeyInfo[] = [];
  for (const r of rows) {
    const fk: ForeignKeyInfo = {
      name: r.name,
      schema: r.schema,
      table: r.table,
      columns: r.columns,
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumns: r.ref_columns,
      onUpdate: FK_ACTIONS[r.on_update] ?? r.on_update,
      onDelete: FK_ACTIONS[r.on_delete] ?? r.on_delete
    };
    (Number(r.owner_oid) === oid ? outgoing : incoming).push(fk);
  }
  return { outgoing, incoming };
}

async function checks(db: Queryable, oid: number): Promise<CheckInfo[]> {
  const { rows } = await db.query<CheckInfo>(
    `SELECT conname AS name, pg_get_constraintdef(oid, true) AS definition
     FROM pg_catalog.pg_constraint WHERE conrelid = $1::oid AND contype = 'c' ORDER BY conname`,
    [oid]
  );
  return rows;
}

function isIdentityColumn(c: ColumnRow): boolean {
  return c.identity === 'a' || c.identity === 'd' || /^nextval\(/i.test(c.default_expr ?? '');
}

export async function describeTable(db: Queryable, schema: string, table: string): Promise<TableStructure> {
  const rel = await relation(db, schema, table);
  const oid = Number(rel.oid);
  const [cols, pk, idx, fks, chk] = await Promise.all([columnRows(db, oid), primaryKey(db, schema, table), indexes(db, oid), foreignKeys(db, oid), checks(db, oid)]);
  const columns: ColumnInfo[] = cols.map((c) => {
    const info: ColumnInfo = {
      name: c.name,
      type: c.type,
      nullable: !c.notnull,
      defaultValue: c.default_expr,
      isPrimaryKey: pk.includes(c.name),
      isIdentity: isIdentityColumn(c),
      ordinal: c.ordinal
    };
    if (c.generated === 's') info.isGenerated = true;
    if (c.comment) info.comment = c.comment;
    return info;
  });
  const kind = relkindToTableKind(rel.relkind);
  const structure: TableStructure = {
    schema,
    name: table,
    kind,
    columns,
    primaryKey: pk,
    indexes: idx,
    foreignKeys: fks.outgoing,
    referencedBy: fks.incoming,
    checks: chk
  };
  if (rel.comment) structure.comment = rel.comment;
  if (kind !== 'view' && rel.estimate !== null && rel.estimate >= 0) structure.rowEstimate = Math.round(rel.estimate);
  return structure;
}

function literal(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** CREATE statement for a table (synthesized from the catalog), view, or materialized view. */
export async function tableDdl(db: Queryable, schema: string, table: string): Promise<string> {
  const rel = await relation(db, schema, table);
  const oid = Number(rel.oid);
  const name = `${quoteIdent('postgres', schema)}.${quoteIdent('postgres', table)}`;

  if (rel.relkind === 'v' || rel.relkind === 'm') {
    const { rows } = await db.query<{ def: string }>('SELECT pg_get_viewdef($1::oid, true) AS def', [oid]);
    const body = (rows[0]?.def ?? '').trim().replace(/;$/, '');
    const head = rel.relkind === 'v' ? `CREATE OR REPLACE VIEW ${name} AS` : `CREATE MATERIALIZED VIEW ${name} AS`;
    let ddl = `${head}\n${body};\n`;
    if (rel.relkind === 'm') for (const i of await indexes(db, oid)) ddl += `\n${i.definition};\n`;
    if (rel.comment) ddl += `\nCOMMENT ON ${rel.relkind === 'v' ? 'VIEW' : 'MATERIALIZED VIEW'} ${name} IS ${literal(rel.comment)};\n`;
    return ddl;
  }

  const [cols, cons, idx, part] = await Promise.all([
    columnRows(db, oid),
    db.query<{ name: string; def: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid, true) AS def FROM pg_catalog.pg_constraint
       WHERE conrelid = $1::oid AND contype IN ('p', 'u', 'f', 'c', 'x')
       ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, conname`,
      [oid]
    ),
    db.query<{ def: string }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
       WHERE i.indrelid = $1::oid AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conindid = i.indexrelid)
       ORDER BY ic.relname`,
      [oid]
    ),
    rel.relkind === 'p' ? db.query<{ def: string }>('SELECT pg_get_partkeydef($1::oid) AS def', [oid]) : Promise.resolve(null)
  ]);

  const lines = cols.map((c) => {
    let line = `    ${quoteIdent('postgres', c.name)} ${c.type}`;
    if (c.generated === 's' && c.default_expr) line += ` GENERATED ALWAYS AS (${c.default_expr}) STORED`;
    else if (c.identity === 'a') line += ' GENERATED ALWAYS AS IDENTITY';
    else if (c.identity === 'd') line += ' GENERATED BY DEFAULT AS IDENTITY';
    else if (c.default_expr) line += ` DEFAULT ${c.default_expr}`;
    if (c.notnull) line += ' NOT NULL';
    return line;
  });
  for (const c of cons.rows) lines.push(`    CONSTRAINT ${quoteIdent('postgres', c.name)} ${c.def}`);

  const unlogged = rel.persistence === 'u' ? 'UNLOGGED ' : '';
  let ddl = `CREATE ${unlogged}TABLE ${name} (\n${lines.join(',\n')}\n)`;
  if (part?.rows[0]?.def) ddl += ` PARTITION BY ${part.rows[0].def}`;
  ddl += ';\n';
  for (const i of idx.rows) ddl += `\n${i.def};\n`;
  if (rel.comment) ddl += `\nCOMMENT ON TABLE ${name} IS ${literal(rel.comment)};\n`;
  for (const c of cols) if (c.comment) ddl += `COMMENT ON COLUMN ${name}.${quoteIdent('postgres', c.name)} IS ${literal(c.comment)};\n`;
  return ddl;
}

/** pg_get_functiondef for every overload with the given name and kind. */
export async function routineDefinition(db: Queryable, schema: string, name: string, kind: RoutineKind): Promise<string> {
  const { rows } = await db.query<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
     ORDER BY pg_get_function_identity_arguments(p.oid)`,
    [schema, name, kind === 'procedure' ? 'p' : 'f']
  );
  if (rows.length === 0) throw new AppError(`No ${kind} named ${schema}.${name}`, 'NOT_FOUND');
  return rows.map((r) => `${r.def.trimEnd()};`).join('\n\n') + '\n';
}

export async function fetchMeta(db: Queryable, maxTables: number): Promise<DbMeta> {
  const schemas = await listSchemas(db);
  const { rows: tables } = await db.query<{ oid: number; schema: string; name: string; relkind: string }>(
    `SELECT c.oid::int8::float8 AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS relkind
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ${RELKINDS} AND ${USER_SCHEMA_FILTER}
     ORDER BY (n.nspname = current_schema()) DESC, n.nspname, c.relname
     LIMIT $1`,
    [maxTables + 1]
  );
  const truncated = tables.length > maxTables;
  const kept = tables.slice(0, maxTables);
  const byOid = new Map<number, DbMeta['tables'][number]>();
  const out: DbMeta['tables'] = kept.map((t) => {
    const entry = { schema: t.schema, name: t.name, kind: relkindToTableKind(t.relkind), columns: [] as { name: string; type: string }[] };
    byOid.set(Number(t.oid), entry);
    return entry;
  });
  if (kept.length > 0) {
    const { rows: cols } = await db.query<{ oid: number; name: string; type: string }>(
      `SELECT a.attrelid::int8::float8 AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attrelid, a.attnum`,
      [kept.map((t) => Number(t.oid))]
    );
    for (const c of cols) byOid.get(Number(c.oid))?.columns.push({ name: c.name, type: c.type });
  }
  const meta: DbMeta = { defaultSchema: schemas.defaultSchema, schemas: schemas.schemas, tables: out };
  if (truncated) meta.truncated = true;
  return meta;
}
