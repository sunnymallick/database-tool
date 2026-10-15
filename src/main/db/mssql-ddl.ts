/**
 * CREATE TABLE synthesis for SQL Server from sys.* catalog facts (SQL Server
 * has no SHOW CREATE TABLE). Pure, so it is unit-tested without a server.
 */
import { qualifiedName, quoteIdent } from '@shared/sql';

export interface MssqlColumnDef {
  name: string;
  /** Rendered type, e.g. `nvarchar(100)`, `decimal(10, 2)`, or an alias type name. */
  type: string;
  nullable: boolean;
  identity?: { seed: string; increment: string };
  computed?: { definition: string; persisted: boolean };
  defaultConstraint?: { name: string | null; definition: string };
  comment?: string;
}

export interface MssqlIndexDef {
  name: string;
  /** sys.indexes.type_desc: CLUSTERED, NONCLUSTERED, ... */
  typeDesc: string;
  unique: boolean;
  primary: boolean;
  uniqueConstraint: boolean;
  columns: { name: string; desc: boolean }[];
  included: string[];
  filter: string | null;
}

export interface MssqlForeignKeyDef {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  /** sys.foreign_keys *_referential_action_desc: NO_ACTION, CASCADE, SET_NULL, SET_DEFAULT. */
  onDelete: string;
  onUpdate: string;
}

export interface MssqlTableDef {
  schema: string;
  name: string;
  columns: MssqlColumnDef[];
  indexes: MssqlIndexDef[];
  foreignKeys: MssqlForeignKeyDef[];
  checks: { name: string; definition: string }[];
  comment?: string;
}

const q = (name: string) => quoteIdent('mssql', name);
const nstr = (s: string) => `N'${s.replace(/'/g, "''")}'`;

function keyList(cols: { name: string; desc: boolean }[]): string {
  return cols.map((c) => `${q(c.name)} ${c.desc ? 'DESC' : 'ASC'}`).join(', ');
}

function action(kind: 'DELETE' | 'UPDATE', desc: string): string {
  const a = desc.replace(/_/g, ' ').trim().toUpperCase();
  return a && a !== 'NO ACTION' ? ` ON ${kind} ${a}` : '';
}

function columnLine(c: MssqlColumnDef): string {
  if (c.computed) return `    ${q(c.name)} AS ${c.computed.definition}${c.computed.persisted ? ' PERSISTED' : ''}`;
  let line = `    ${q(c.name)} ${c.type}`;
  if (c.identity) line += ` IDENTITY(${c.identity.seed},${c.identity.increment})`;
  line += c.nullable ? ' NULL' : ' NOT NULL';
  if (c.defaultConstraint) {
    const named = c.defaultConstraint.name ? ` CONSTRAINT ${q(c.defaultConstraint.name)}` : '';
    line += `${named} DEFAULT ${c.defaultConstraint.definition}`;
  }
  return line;
}

function commentStatement(schema: string, table: string, comment: string, column?: string): string {
  const col = column ? `, @level2type = N'COLUMN', @level2name = ${nstr(column)}` : '';
  return `EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = ${nstr(comment)}, @level0type = N'SCHEMA', @level0name = ${nstr(schema)}, @level1type = N'TABLE', @level1name = ${nstr(table)}${col};`;
}

export function mssqlCreateTableDdl(t: MssqlTableDef): string {
  const target = qualifiedName('mssql', t.schema, t.name);
  const lines = t.columns.map(columnLine);

  for (const i of t.indexes.filter((x) => x.primary || x.uniqueConstraint)) {
    const kind = i.primary ? 'PRIMARY KEY' : 'UNIQUE';
    lines.push(`    CONSTRAINT ${q(i.name)} ${kind} ${i.typeDesc} (${keyList(i.columns)})`);
  }
  for (const fk of t.foreignKeys) {
    lines.push(
      `    CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${qualifiedName('mssql', fk.refSchema, fk.refTable)} (${fk.refColumns.map(q).join(', ')})${action('DELETE', fk.onDelete)}${action('UPDATE', fk.onUpdate)}`
    );
  }
  for (const c of t.checks) lines.push(`    CONSTRAINT ${q(c.name)} CHECK ${c.definition}`);

  let ddl = `CREATE TABLE ${target} (\n${lines.join(',\n')}\n);\n`;
  for (const i of t.indexes.filter((x) => !x.primary && !x.uniqueConstraint)) {
    // Columnstore, XML, and spatial indexes have their own syntax; say so rather than script them wrongly.
    if (i.typeDesc !== 'CLUSTERED' && i.typeDesc !== 'NONCLUSTERED') {
      ddl += `\n-- ${i.typeDesc} index ${q(i.name)} is not scripted.\n`;
      continue;
    }
    const include = i.included.length > 0 ? ` INCLUDE (${i.included.map(q).join(', ')})` : '';
    const where = i.filter ? ` WHERE ${i.filter}` : '';
    ddl += `\nCREATE ${i.unique ? 'UNIQUE ' : ''}${i.typeDesc} INDEX ${q(i.name)} ON ${target} (${keyList(i.columns)})${include}${where};\n`;
  }
  const comments: string[] = [];
  if (t.comment) comments.push(commentStatement(t.schema, t.name, t.comment));
  for (const c of t.columns) if (c.comment) comments.push(commentStatement(t.schema, t.name, c.comment, c.name));
  if (comments.length > 0) ddl += `\n${comments.join('\n')}\n`;
  return ddl;
}
