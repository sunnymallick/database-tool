/**
 * Schema completion data for @codemirror/lang-sql built from `db.meta`.
 */
import type { Completion } from '@codemirror/autocomplete';
import type { SQLConfig, SQLNamespace } from '@codemirror/lang-sql';
import type { DbMeta } from '@shared/types';

export function completionConfig(meta: DbMeta | null | undefined): Pick<SQLConfig, 'schema' | 'defaultSchema'> {
  if (!meta) return {};
  const schemas: Record<string, Record<string, SQLNamespace>> = {};
  for (const s of meta.schemas) schemas[s] = {};
  for (const t of meta.tables) {
    const columns: Completion[] = t.columns.map((c) => ({ label: c.name, type: 'property', detail: c.type }));
    const self: Completion = {
      label: t.name,
      type: t.kind === 'table' ? 'class' : 'interface',
      detail: t.kind === 'table' ? 'table' : t.kind === 'view' ? 'view' : 'mat. view'
    };
    (schemas[t.schema] ??= {})[t.name] = { self, children: columns };
  }
  const schema: Record<string, SQLNamespace> = {};
  for (const [name, tables] of Object.entries(schemas)) {
    schema[name] = { self: { label: name, type: 'namespace', detail: 'schema' }, children: tables };
  }
  return { schema, defaultSchema: meta.defaultSchema || undefined };
}
