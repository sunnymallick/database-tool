/**
 * Read-only enforcement at the registry boundary, so no caller (editor, table
 * view, or AI agent) can bypass it and no driver has to remember it.
 */
import { findWrite } from '@shared/sql';
import type { ApplyChangesResult, ResultSet, RowChangeSet, TablePage } from '@shared/types';
import { AppError } from '../errors';
import type { Driver, ExecuteOptions, FetchRowsSpec } from '../db/driver';

export const READ_ONLY_CODE = 'READ_ONLY';

export interface ReadOnlyRefusal {
  keyword: string;
  statementIndex: number;
  /** Offset of the offending statement in the submitted SQL. */
  position: number;
}

/** The error thrown for a refused script; `details` locates the statement. */
export function readOnlyError(sql: string, kind: Driver['kind']): AppError | null {
  const hit = findWrite(sql, kind);
  if (!hit) return null;
  const details: ReadOnlyRefusal = { keyword: hit.keyword, statementIndex: hit.statementIndex, position: hit.statement.start };
  return new AppError(`This connection is read-only: ${hit.keyword} statements are not allowed.`, READ_ONLY_CODE, details);
}

/** Wrap a driver so that writes are refused before reaching the server. */
export function readOnlyDriver(inner: Driver): Driver {
  return {
    kind: inner.kind,
    database: inner.database,
    serverVersion: () => inner.serverVersion(),
    ping: () => inner.ping(),
    close: () => inner.close(),
    listDatabases: () => inner.listDatabases(),
    listSchemas: () => inner.listSchemas(),
    listTables: (schema) => inner.listTables(schema),
    listRoutines: (schema) => inner.listRoutines(schema),
    describeTable: (schema, table) => inner.describeTable(schema, table),
    tableDdl: (schema, table) => inner.tableDdl(schema, table),
    routineDefinition: (schema, name, kind) => inner.routineDefinition(schema, name, kind),
    fetchMeta: (opts) => inner.fetchMeta(opts),
    ...(inner.sessionContext ? { sessionContext: () => inner.sessionContext!() } : {}),

    execute(sql: string, opts: ExecuteOptions): Promise<ResultSet[]> {
      const refusal = readOnlyError(sql, inner.kind);
      return refusal ? Promise.reject(refusal) : inner.execute(sql, opts);
    },

    fetchRows(spec: FetchRowsSpec): Promise<TablePage> {
      // The WHERE body is user text spliced into a SELECT; it must not smuggle in a write.
      if (spec.where && findWrite(`SELECT * FROM t WHERE ${spec.where}`, inner.kind)) {
        return Promise.reject(new AppError('This connection is read-only: the filter contains a write statement.', READ_ONLY_CODE));
      }
      return inner.fetchRows(spec);
    },

    applyChanges(schema: string, table: string, changes: RowChangeSet, opts: { preview: boolean }): Promise<ApplyChangesResult> {
      // Previews only render SQL; applying is refused.
      if (!opts.preview) return Promise.reject(new AppError('This connection is read-only: row edits are disabled.', READ_ONLY_CODE));
      return inner.applyChanges(schema, table, changes, opts);
    }
  };
}
