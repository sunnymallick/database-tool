import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile, ConnectionStatus } from '@shared/types';
import type { Driver } from '../../src/main/db/driver';
import { QueryRunner } from '../../src/main/db/query-runner';
import { AppError } from '../../src/main/errors';
import { readOnlyDriver } from '../../src/main/connections/guard';
import { Registry, connectTimeoutMs, resolveDatabase, type ConnectFn } from '../../src/main/connections/registry';
import {
  FallbackSecretStore,
  FileSecretStore,
  KeychainSecretStore,
  createSecretStore,
  keychainService,
  type CommandRunner,
  type SecretStore
} from '../../src/main/connections/secrets';
import { ProfileStore, connectionFieldsChanged, normalizeProfile } from '../../src/main/connections/store';
import { profile, tempDir } from '../integration/support';

const tmp = tempDir('connections');
afterAll(() => tmp.cleanup());

describe('ProfileStore', () => {
  it('validates, normalizes, and persists profiles without passwords', () => {
    const file = join(tmp.dir, 'profiles-a.json');
    const store = new ProfileStore(file);
    const { saved, previous } = store.upsert({
      ...profile('postgres', { id: '', name: '  Local ', host: ' db ', port: 0, database: 'app', extraDatabases: ['app', 'b', 'b', ' '], color: '#ABCDEF' }),
      hasPassword: true
    });
    expect(previous).toBeUndefined();
    expect(saved.id).toMatch(/[0-9a-f-]{36}/);
    expect(saved).toMatchObject({ name: 'Local', host: 'db', port: 5432, extraDatabases: ['b'], color: '#abcdef', hasPassword: false });
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.profiles[0]).not.toHaveProperty('hasPassword');

    const again = store.upsert({ ...saved, name: 'Renamed' });
    expect(again.previous?.name).toBe('Local');
    expect(again.saved.createdAt).toBe(saved.createdAt);
    expect(new ProfileStore(file).list().map((p) => p.name)).toEqual(['Renamed']);
    expect(store.remove(saved.id)?.name).toBe('Renamed');
    expect(store.list()).toEqual([]);
  });

  it('rejects unusable profiles with readable messages', () => {
    const store = new ProfileStore(join(tmp.dir, 'profiles-b.json'));
    expect(() => store.upsert(profile('postgres', { name: '' }))).toThrow('Give the connection a name');
    expect(() => store.upsert(profile('postgres', { host: '' }))).toThrow('Enter a host name');
    expect(() => store.upsert(profile('postgres', { port: 70000 }))).toThrow(/Port must be/);
    expect(() => store.upsert(profile('sqlite', { filePath: '' }))).toThrow('Choose a SQLite database file');
    expect(() => store.upsert(profile('mysql', { color: 'red' }))).toThrow(/#rrggbb/);
    expect(() => store.upsert(profile('mysql', { options: { connectTimeoutSec: '0' } }))).toThrow(/timeout/);
    expect(() => store.upsert({ ...profile('postgres'), kind: 'oracle' as never })).toThrow(/Unknown database kind/);
  });

  it('reads legacy array files and survives corrupt files', () => {
    const legacy = join(tmp.dir, 'legacy.json');
    writeFileSync(legacy, JSON.stringify([{ id: 'x', name: 'Old', kind: 'sqlite', filePath: '/tmp/a.db' }]));
    expect(new ProfileStore(legacy).list()).toEqual([expect.objectContaining({ id: 'x', kind: 'sqlite', filePath: '/tmp/a.db', host: '', port: 0 })]);
    const corrupt = join(tmp.dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not json');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(new ProfileStore(corrupt).list()).toEqual([]);
    err.mockRestore();
    expect(readdirSync(tmp.dir).some((f) => f.startsWith('corrupt.json.corrupt-'))).toBe(true);
  });

  it('knows which edits require reconnecting', () => {
    const a = normalizeProfile(profile('postgres', { host: 'a' }));
    expect(connectionFieldsChanged(a, { ...a, name: 'other', color: '#000000', production: true })).toBe(false);
    expect(connectionFieldsChanged(a, { ...a, host: 'b' })).toBe(true);
    expect(connectionFieldsChanged(a, { ...a, readOnly: true })).toBe(true);
    expect(connectionFieldsChanged(a, { ...a, options: { connectTimeoutSec: '5' } })).toBe(true);
  });
});

describe('secret stores', () => {
  it('file store keeps secrets in a 0600 file', async () => {
    const file = join(tmp.dir, 'secrets.json');
    const s = new FileSecretStore(file);
    expect(await s.get('p1')).toBeNull();
    await s.set('p1', 'pw:with "quotes"\n');
    expect(await s.get('p1')).toBe('pw:with "quotes"\n');
    expect(await s.has('p1')).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await s.delete('p1');
    expect(await s.has('p1')).toBe(false);
  });

  it('keychain store drives `security` with the documented arguments', async () => {
    const calls: string[][] = [];
    const items = new Map<string, string>();
    const runner: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const account = args[args.indexOf('-a') + 1];
      switch (args[0]) {
        case 'add-generic-password':
          items.set(account, args[args.indexOf('-w') + 1]);
          return { code: 0, stdout: '', stderr: '' };
        case 'find-generic-password':
          if (!items.has(account)) return { code: 44, stdout: '', stderr: 'not found' };
          return { code: 0, stdout: args.includes('-w') ? `${items.get(account)}\n` : 'attributes', stderr: '' };
        case 'delete-generic-password':
          return items.delete(account) ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
        default:
          return { code: 1, stdout: '', stderr: 'unexpected' };
      }
    };
    const kc = new KeychainSecretStore('database-tool-test', runner);
    expect(await kc.get('id-1')).toBeNull();
    await kc.set('id-1', '-starts-with-dash');
    expect(calls[1]).toEqual(['/usr/bin/security', 'add-generic-password', '-U', '-s', 'database-tool-test', '-a', 'id-1', '-w', '-starts-with-dash']);
    expect(await kc.get('id-1')).toBe('-starts-with-dash');
    expect(await kc.has('id-1')).toBe(true);
    expect(calls[calls.length - 1]).not.toContain('-w');
    await kc.delete('id-1');
    await kc.delete('id-1');
    expect(await kc.has('id-1')).toBe(false);

    const broken = new KeychainSecretStore('svc', async () => ({ code: 36, stdout: '', stderr: 'User interaction is not allowed.' }));
    await expect(broken.get('x')).rejects.toMatchObject({ code: 'KEYCHAIN', message: expect.stringContaining('User interaction is not allowed') });
  });

  it('falls back to the file when the Keychain refuses a write', async () => {
    const file = new FileSecretStore(join(tmp.dir, 'fallback.json'));
    const locked: SecretStore = {
      kind: 'keychain',
      get: async () => null,
      set: async () => {
        throw new Error('locked');
      },
      delete: async () => undefined,
      has: async () => false
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = new FallbackSecretStore(locked, file);
    await s.set('p', 'pw');
    err.mockRestore();
    expect(await s.get('p')).toBe('pw');
    expect(await s.has('p')).toBe(true);
    await s.delete('p');
    expect(await s.get('p')).toBeNull();
  });

  it('picks the backend for the platform and honors overrides', () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' });
    const file = join(tmp.dir, 'pick.json');
    expect(createSecretStore({ platform: 'linux', file }).kind).toBe('file');
    expect(createSecretStore({ platform: 'darwin', runner, file }).kind).toBe('keychain+file');
    vi.stubEnv('DATABASE_TOOL_SECRETS', 'file');
    expect(createSecretStore({ platform: 'darwin', runner, file }).kind).toBe('file');
    vi.stubEnv('DATABASE_TOOL_KEYCHAIN_SERVICE', 'custom-service');
    expect(keychainService()).toBe('custom-service');
    vi.unstubAllEnvs();
    expect(keychainService()).toBe('database-tool');
  });
});

// -- registry -----------------------------------------------------------------

function fakeDriver(kind: Driver['kind'] = 'postgres', database = 'app'): Driver & { closed: boolean } {
  const d = {
    kind,
    database,
    closed: false,
    serverVersion: vi.fn(async () => 'Fake 1.0'),
    ping: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      d.closed = true;
    }),
    listDatabases: vi.fn(async () => []),
    listSchemas: vi.fn(async () => ({ schemas: ['public'], defaultSchema: 'public' })),
    listTables: vi.fn(async () => []),
    listRoutines: vi.fn(async () => []),
    describeTable: vi.fn(),
    tableDdl: vi.fn(async () => ''),
    routineDefinition: vi.fn(async () => ''),
    execute: vi.fn(async () => []),
    fetchRows: vi.fn(async () => ({ result: { columns: [], rows: [], truncated: false, statement: '', statementIndex: 0, durationMs: 0 }, total: null, primaryKey: [] })),
    applyChanges: vi.fn(async () => ({ statements: [], applied: 0 })),
    fetchMeta: vi.fn(async () => ({ defaultSchema: 'public', schemas: [], tables: [] }))
  };
  return d as unknown as Driver & { closed: boolean };
}

function registryWith(profiles: ConnectionProfile[], connect: ConnectFn) {
  const events: ConnectionStatus[] = [];
  const registry = new Registry({
    getProfile: (id) => profiles.find((p) => p.id === id),
    listProfiles: () => profiles,
    getPassword: async (id) => `pw-${id}`,
    onStatus: (s) => events.push(s),
    connect
  });
  return { registry, events };
}

describe('Registry', () => {
  afterEach(() => vi.useRealTimers());

  it('connects once per (profile, database), reports statuses, and shares in-flight attempts', async () => {
    const p = profile('postgres', { id: 'p1', database: 'app' });
    const connect = vi.fn<ConnectFn>(async (_prof, _pw, db) => fakeDriver('postgres', db));
    const { registry, events } = registryWith([p], connect);
    const [a, b] = await Promise.all([registry.acquire({ profileId: 'p1' }), registry.acquire({ profileId: 'p1', database: 'app' })]);
    expect(a).toBe(b);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0].slice(1, 3)).toEqual(['pw-p1', 'app']);
    expect(events.map((e) => e.state)).toEqual(['connecting', 'connected']);
    expect(registry.status({ profileId: 'p1' })).toMatchObject({ state: 'connected', serverVersion: 'Fake 1.0', database: 'app' });

    await registry.acquire({ profileId: 'p1', database: 'other' });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(registry.statuses()).toHaveLength(2);

    await registry.disconnectProfile('p1');
    expect(registry.statuses()).toEqual([]);
    expect(events.filter((e) => e.state === 'disconnected')).toHaveLength(2);
    expect(registry.status({ profileId: 'p1' }).state).toBe('disconnected');
  });

  it('records failures and retries on the next request', async () => {
    const p = profile('mysql', { id: 'p2', name: 'Shop', database: 'shop' });
    let fail = true;
    const { registry, events } = registryWith([p], async () => {
      if (fail) throw new Error('ECONNREFUSED 127.0.0.1:3306');
      return fakeDriver('mysql');
    });
    await expect(registry.acquire({ profileId: 'p2' })).rejects.toMatchObject({ code: 'CONNECT_FAILED', message: 'Could not connect to Shop (shop): ECONNREFUSED 127.0.0.1:3306' });
    expect(events.at(-1)).toMatchObject({ state: 'error', error: 'ECONNREFUSED 127.0.0.1:3306' });
    const status = await registry.connectRef({ profileId: 'p2' });
    expect(status.state).toBe('error');
    fail = false;
    expect((await registry.connectRef({ profileId: 'p2' })).state).toBe('connected');
  });

  it('times out slow connects and closes them if they finish later', async () => {
    vi.useFakeTimers();
    const p = profile('postgres', { id: 'p3', options: { connectTimeoutSec: '1' } });
    expect(connectTimeoutMs(p)).toBe(1000);
    const late = fakeDriver();
    let finish: (d: Driver) => void = () => undefined;
    const { registry } = registryWith([p], () => new Promise<Driver>((r) => (finish = r)));
    const attempt = registry.acquire({ profileId: 'p3' });
    const assertion = expect(attempt).rejects.toMatchObject({ message: expect.stringContaining('Timed out after 1s') });
    await vi.advanceTimersByTimeAsync(6500);
    await assertion;
    finish(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.closed).toBe(true);
  });

  it('discards a connect that finishes after a disconnect', async () => {
    const p = profile('postgres', { id: 'p4' });
    const late = fakeDriver();
    let finish: (d: Driver) => void = () => undefined;
    const { registry } = registryWith([p], () => new Promise<Driver>((r) => (finish = r)));
    const attempt = registry.acquire({ profileId: 'p4' });
    await new Promise((r) => setImmediate(r));
    await registry.disconnect({ profileId: 'p4' });
    finish(late);
    await expect(attempt).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(late.closed).toBe(true);
  });

  it('wraps read-only profiles in the guard and ignores the database for SQLite', async () => {
    const ro = profile('postgres', { id: 'ro', readOnly: true });
    const lite = profile('sqlite', { id: 'lite', filePath: '/tmp/x.db' });
    const connect = vi.fn<ConnectFn>(async (prof) => fakeDriver(prof.kind));
    const { registry } = registryWith([ro, lite], connect);
    const guarded = await registry.acquire({ profileId: 'ro' });
    await expect(guarded.execute('UPDATE t SET x = 1', { rowCap: 10 })).rejects.toMatchObject({ code: 'READ_ONLY' });
    await expect(guarded.execute('SELECT 1', { rowCap: 10 })).resolves.toEqual([]);
    expect(connect.mock.calls[0][3]).toMatchObject({ readOnly: true });
    expect(resolveDatabase(lite, { profileId: 'lite', database: 'ignored' })).toBe('');
    await registry.acquire({ profileId: 'lite', database: 'a' });
    await registry.acquire({ profileId: 'lite', database: 'b' });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1][1]).toBeNull();
    await expect(registry.acquire({ profileId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await registry.closeAll();
  });
});

describe('read-only guard', () => {
  it('refuses writes, write filters, and applying edits, but allows reads and previews', async () => {
    const inner = fakeDriver('mssql');
    const g = readOnlyDriver(inner);
    const refusal = await g.execute('SELECT 1;\nDELETE FROM t', { rowCap: 1 }).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'READ_ONLY', message: 'This connection is read-only: DELETE statements are not allowed.', details: { keyword: 'DELETE', statementIndex: 1, position: 10 } });
    await expect(g.fetchRows({ schema: 'dbo', table: 't', where: '1=1) DROP TABLE x --', limit: 1, offset: 0 })).rejects.toMatchObject({ code: 'READ_ONLY' });
    await g.fetchRows({ schema: 'dbo', table: 't', where: "name = 'drop'", limit: 1, offset: 0 });
    await expect(g.applyChanges('dbo', 't', { updates: [], inserts: [], deletes: [] }, { preview: false })).rejects.toMatchObject({ code: 'READ_ONLY' });
    await g.applyChanges('dbo', 't', { updates: [], inserts: [], deletes: [] }, { preview: true });
    await g.listSchemas();
    expect(inner.execute).not.toHaveBeenCalled();
    expect(inner.fetchRows).toHaveBeenCalledTimes(1);
    expect(inner.applyChanges).toHaveBeenCalledTimes(1);
    expect(g.kind).toBe('mssql');
    expect(existsSync(tmp.dir)).toBe(true);
  });
});

describe('QueryRunner editable detection', () => {
  const result = (cols: string[]) => [{ columns: cols.map((name) => ({ name, type: 'int' })), rows: [], truncated: false, statement: '', statementIndex: 0, durationMs: 0 }];

  function runnerWith(driver: Driver) {
    const p = profile('mssql', { id: 'm1', database: 'Orders' });
    const { registry } = registryWith([p], async () => driver);
    const history: unknown[] = [];
    const runner = new QueryRunner({ registry, getSettings: () => ({ rowCap: 100 }) as never, recordHistory: (e) => history.push(e) });
    return { runner, history };
  }

  it('follows the session search path and refuses edits after a console USE', async () => {
    const driver = fakeDriver('mssql', 'Orders');
    const { runner } = runnerWith(driver);
    vi.mocked(driver.execute).mockImplementation(async () => result(['Id', 'Total']));
    vi.mocked(driver.describeTable).mockImplementation(async (schema: string, table: string) => {
      if (schema !== 'dbo') throw new AppError(`Table ${schema}.${table} was not found`, 'NOT_FOUND');
      return { primaryKey: ['Id'] } as never;
    });
    let switched = false;
    (driver as Driver).sessionContext = async () => ({ searchPath: ['sales', 'dbo'], switchedDatabase: switched });

    const ok = await runner.run({ conn: { profileId: 'm1' }, queryId: 'a', sql: 'SELECT Id, Total FROM Orders' });
    expect(ok.results[0].editable).toEqual({ schema: 'dbo', table: 'Orders', primaryKey: ['Id'] });
    switched = true;
    const afterUse = await runner.run({ conn: { profileId: 'm1' }, queryId: 'b', sql: 'SELECT Id, Total FROM Orders' });
    expect(afterUse.results[0].editable).toBeUndefined();
  });
});
