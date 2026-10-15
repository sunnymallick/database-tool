/**
 * OWNER: data-layer slice. Registers connections.*, db.*, history.*,
 * snippets.*, settings.*, session.* handlers and returns the services the AI
 * slice uses. Must not import 'electron' (stays testable under plain Node).
 */
import type { ConnRef, FetchRowsRequest, HistoryEntry, TableRef } from '@shared/types';
import { AppError } from '../errors';
import { ConnectionManager } from '../connections/manager';
import { Registry, type ConnectFn } from '../connections/registry';
import { createSecretStore, execRunner, type CommandRunner, type SecretStore } from '../connections/secrets';
import { ProfileStore } from '../connections/store';
import { connectDriver } from '../db';
import { QueryRunner } from '../db/query-runner';
import { HistoryStore } from '../workspace/history';
import { SessionStore } from '../workspace/session';
import { SettingsStore } from '../workspace/settings';
import { SnippetStore } from '../workspace/snippets';
import type { DataServices } from '../services';
import type { Router } from './types';

/** Overrides for tests; production uses the defaults. */
export interface DataDeps {
  secrets?: SecretStore;
  connect?: ConnectFn;
  /** Runs `security` for the dbTool Keychain import. */
  keychainRunner?: CommandRunner;
  dbtoolDir?: () => string;
}

function connRef(v: unknown): ConnRef {
  const ref = v as ConnRef | undefined;
  if (!ref || typeof ref.profileId !== 'string' || !ref.profileId) throw new AppError('Missing connection reference', 'BAD_REQUEST');
  if (ref.database !== undefined && typeof ref.database !== 'string') throw new AppError('Database name must be text', 'BAD_REQUEST');
  return ref;
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new AppError(`Missing ${what}`, 'BAD_REQUEST');
  return v;
}

function tableRef(v: unknown): TableRef {
  const t = v as TableRef | undefined;
  if (!t) throw new AppError('Missing table reference', 'BAD_REQUEST');
  return { conn: connRef(t.conn), schema: text(t.schema, 'schema'), table: text(t.table, 'table name') };
}

export function createDataServices(router: Router, deps: DataDeps = {}): DataServices {
  const settings = new SettingsStore(undefined, (s) => router.emit('settings.changed', s));
  const history = new HistoryStore();
  const snippets = new SnippetStore();
  const session = new SessionStore();
  const store = new ProfileStore();
  const secrets = deps.secrets ?? createSecretStore();
  const connect = deps.connect ?? connectDriver;

  const registry: Registry = new Registry({
    getProfile: (id) => manager.getCached(id),
    listProfiles: () => manager.listCached(),
    getPassword: (id) => secrets.get(id),
    onStatus: (status) => router.emit('connections.status', status),
    connect
  });
  const manager: ConnectionManager = new ConnectionManager({
    store,
    secrets,
    registry,
    connect,
    onChanged: (profiles) => router.emit('connections.changed', profiles),
    keychainRunner: deps.keychainRunner ?? (process.platform === 'darwin' ? execRunner : undefined),
    dbtoolDir: deps.dbtoolDir
  });

  const recordHistory = (entry: Omit<HistoryEntry, 'id' | 'ts'>): void => {
    try {
      history.append(entry);
    } catch (err) {
      console.error('[history] could not record entry:', err);
    }
  };
  const queries = new QueryRunner({ registry, getSettings: () => settings.get(), recordHistory });
  const driverFor = (ref: unknown) => registry.acquire(connRef(ref));

  // -- connections ------------------------------------------------------------
  router.handle('connections.list', () => manager.list());
  router.handle('connections.save', (req) => manager.save(req));
  router.handle('connections.delete', (req) => manager.delete(text(req?.profileId, 'profile id')));
  router.handle('connections.test', (req) => manager.test(req));
  router.handle('connections.connect', (ref) => registry.connectRef(connRef(ref)));
  router.handle('connections.disconnect', (ref) => registry.disconnect(connRef(ref)));
  router.handle('connections.statuses', () => registry.statuses());
  router.handle('connections.importDbtool', (req) => manager.importDbtool(req));

  // -- database ---------------------------------------------------------------
  router.handle('db.databases', async (req) => (await driverFor(req?.conn)).listDatabases());
  router.handle('db.schemas', async (req) => (await driverFor(req?.conn)).listSchemas());
  router.handle('db.tables', async (req) => (await driverFor(req?.conn)).listTables(text(req.schema, 'schema')));
  router.handle('db.routines', async (req) => (await driverFor(req?.conn)).listRoutines(text(req.schema, 'schema')));
  router.handle('db.structure', async (req) => {
    const t = tableRef(req);
    return (await driverFor(t.conn)).describeTable(t.schema, t.table);
  });
  router.handle('db.ddl', async (req) => {
    const t = tableRef(req);
    return (await driverFor(t.conn)).tableDdl(t.schema, t.table);
  });
  router.handle('db.routineDefinition', async (req) => {
    if (req?.kind !== 'function' && req?.kind !== 'procedure') throw new AppError('Routine kind must be function or procedure', 'BAD_REQUEST');
    return (await driverFor(req.conn)).routineDefinition(text(req.schema, 'schema'), text(req.name, 'routine name'), req.kind);
  });
  router.handle('db.query', (req) => queries.run(req));
  router.handle('db.cancel', (req) => queries.cancel(text(req?.queryId, 'query id')));
  router.handle('db.rows', async (req: FetchRowsRequest) => {
    const t = tableRef(req?.table);
    const page = await (await driverFor(t.conn)).fetchRows({
      schema: t.schema,
      table: t.table,
      where: typeof req.where === 'string' ? req.where : undefined,
      orderBy: Array.isArray(req.orderBy) ? req.orderBy : undefined,
      limit: req.limit,
      offset: req.offset,
      countTotal: req.countTotal === true
    });
    // Every page of a keyed table maps 1:1 onto its rows (views and keyless tables have no key).
    if (page.primaryKey.length > 0) page.result.editable = { schema: t.schema, table: t.table, primaryKey: page.primaryKey };
    return page;
  });
  router.handle('db.applyChanges', async (req) => {
    const t = tableRef(req?.table);
    const changes = req.changes;
    if (!changes || !Array.isArray(changes.updates) || !Array.isArray(changes.inserts) || !Array.isArray(changes.deletes)) {
      throw new AppError('Changes need updates, inserts, and deletes lists', 'BAD_REQUEST');
    }
    return (await driverFor(t.conn)).applyChanges(t.schema, t.table, changes, { preview: req.preview === true });
  });
  router.handle('db.meta', async (req) => (await driverFor(req?.conn)).fetchMeta({ maxTables: 2000 }));

  // -- workspace --------------------------------------------------------------
  router.handle('history.list', (req) => history.list(req ?? {}));
  router.handle('history.clear', () => history.clear());
  router.handle('snippets.list', () => snippets.list());
  router.handle('snippets.save', (req) => snippets.save(req));
  router.handle('snippets.delete', (req) => snippets.delete(text(req?.id, 'snippet id')));
  router.handle('settings.get', () => settings.get());
  router.handle('settings.update', (req) => settings.update(req));
  router.handle('session.load', () => session.load());
  router.handle('session.save', (req) => session.save(req));

  return {
    registry,
    getSettings: () => settings.get(),
    recordHistory,
    shutdown: () => registry.closeAll()
  };
}
