import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionProfile, DbKind } from '@shared/types';
import { normalizeProfile } from '../../src/main/connections/store';
import { connRefFor, exposedProfiles, externalReadRefusal, parseScope, resolveProfile } from '../../src/main/external/access';
import { LiveProfiles } from '../../src/main/external/services';
import { profile, tempDir } from '../integration/support';

const p = (overrides: Partial<ConnectionProfile>) => profile('postgres', { database: 'app', ...overrides });

describe('normalizeProfile', () => {
  it('defaults Claude Code access to off', () => {
    expect(normalizeProfile({ name: 'x', kind: 'postgres', host: 'h' }).claudeCodeAccess).toBe(false);
    expect(normalizeProfile({ name: 'x', kind: 'postgres', host: 'h', claudeCodeAccess: 'yes' as never }).claudeCodeAccess).toBe(false);
    expect(normalizeProfile({ name: 'x', kind: 'postgres', host: 'h', claudeCodeAccess: true }).claudeCodeAccess).toBe(true);
  });
});

describe('exposedProfiles', () => {
  const all = [
    p({ id: 'a', name: 'Local PG', claudeCodeAccess: true }),
    p({ id: 'b', name: 'Prod', claudeCodeAccess: true, production: true }),
    p({ id: 'c', name: 'Secret', claudeCodeAccess: false })
  ];

  it('only returns profiles with access on, all forced read-only', () => {
    const out = exposedProfiles(all);
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
    expect(out.every((x) => x.readOnly)).toBe(true);
    expect(all[0].readOnly).toBe(false); // input untouched
  });

  it('narrows by name (case-insensitive) or id and never widens', () => {
    expect(exposedProfiles(all, parseScope('local pg')).map((x) => x.id)).toEqual(['a']);
    expect(exposedProfiles(all, parseScope(' b , Secret ')).map((x) => x.id)).toEqual(['b']);
    expect(exposedProfiles(all, parseScope('nope'))).toEqual([]);
  });
});

describe('resolveProfile', () => {
  const exposed = exposedProfiles([
    p({ id: 'a', name: 'Dup', claudeCodeAccess: true }),
    p({ id: 'b', name: 'dup', claudeCodeAccess: true }),
    p({ id: 'c', name: 'Solo', claudeCodeAccess: true })
  ]);

  it('finds by id or unique name', () => {
    expect(resolveProfile(exposed, 'solo').id).toBe('c');
    expect(resolveProfile(exposed, 'b').id).toBe('b');
  });

  it('refuses ambiguous and unshared names', () => {
    expect(() => resolveProfile(exposed, 'DUP')).toThrow(/Several/);
    expect(() => resolveProfile(exposed, 'Secret')).toThrow(/not|No connection "Secret"/);
    expect(() => resolveProfile(exposed, '')).toThrow(/required/);
  });
});

describe('connRefFor', () => {
  const prof = p({ id: 'a', database: 'app', extraDatabases: ['reporting'] });

  it('allows the default and additional databases only', () => {
    expect(connRefFor(prof)).toEqual({ profileId: 'a' });
    expect(connRefFor(prof, 'APP')).toEqual({ profileId: 'a' });
    expect(connRefFor(prof, 'Reporting')).toEqual({ profileId: 'a', database: 'reporting' });
    expect(() => connRefFor(prof, 'master')).toThrow(/not set up for database "master"/);
  });

  it('ignores the database for SQLite', () => {
    expect(connRefFor(profile('sqlite', { id: 's' }), 'whatever')).toEqual({ profileId: 's' });
  });
});

describe('LiveProfiles', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('picks up edits to connections.json without a restart', () => {
    const t = tempDir('live-profiles');
    cleanup = t.cleanup;
    const file = join(t.dir, 'connections.json');
    const live = new LiveProfiles(file);
    expect(live.read().profiles).toEqual([]);

    writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ id: 'a', name: 'A', kind: 'postgres', host: 'h', claudeCodeAccess: true }] }));
    let r = live.read();
    expect(r.changed).toBe(true);
    expect(r.profiles[0].claudeCodeAccess).toBe(true);
    expect(live.read().changed).toBe(false);

    writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ id: 'a', name: 'A', kind: 'postgres', host: 'h', claudeCodeAccess: false }] }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    r = live.read();
    expect(r.changed).toBe(true);
    expect(r.profiles[0].claudeCodeAccess).toBe(false);
  });
});

describe('externalReadRefusal', () => {
  const refused: [string, DbKind][] = [
    // Switching the session back to read-write, or to another database.
    ['BEGIN READ WRITE', 'postgres'],
    ['START TRANSACTION READ WRITE', 'mysql'],
    ['SELECT 1; COMMIT', 'postgres'],
    ['USE secret', 'mysql'],
    ['USE master', 'mssql'],
    // T-SQL needs no separator between statements.
    ['SELECT 1 USE master', 'mssql'],
    ['SELECT 1 BEGIN TRAN', 'mssql'],
    ['SELECT 1 SET NOCOUNT ON', 'mssql'],
    ['SELECT 1 DECLARE @x int', 'mssql'],
    ["SELECT 1 WAITFOR DELAY '00:01'", 'mssql'],
    ['SELECT 1 EXEC sp_who', 'mssql'],
    // Plain writes still go through the shared guard.
    ['DELETE FROM t', 'postgres'],
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres'],
    ['SELECT * INTO copy FROM t', 'mssql'],
    ["SELECT set_config('default_transaction_read_only', 'off', false)", 'postgres']
  ];
  it.each(refused)('refuses %s (%s)', (sql, kind) => {
    expect(externalReadRefusal(sql, kind)).not.toBeNull();
  });

  const allowed: [string, DbKind][] = [
    ['SELECT 1; SELECT 2', 'postgres'],
    ['WITH c AS (SELECT 1 AS x) SELECT * FROM c', 'mssql'],
    ['SELECT TOP 5 [set], [use] FROM dbo.t', 'mssql'],
    ["SELECT 'BEGIN; USE master' AS s -- SET", 'mssql'],
    ['EXPLAIN SELECT 1', 'postgres'],
    ['SHOW TABLES', 'mysql'],
    ['PRAGMA table_info(orders)', 'sqlite'],
    ['(SELECT 1) UNION (SELECT 2)', 'postgres']
  ];
  it.each(allowed)('allows %s (%s)', (sql, kind) => {
    expect(externalReadRefusal(sql, kind)).toBeNull();
  });
});

describe('LiveProfiles failure handling', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('fails closed on a corrupt file and never moves it', () => {
    const t = tempDir('live-corrupt');
    cleanup = t.cleanup;
    const file = join(t.dir, 'connections.json');
    writeFileSync(file, JSON.stringify({ version: 1, profiles: [{ id: 'a', name: 'A', kind: 'postgres', host: 'h', claudeCodeAccess: true }] }));
    const live = new LiveProfiles(file);
    expect(live.read().profiles).toHaveLength(1);

    writeFileSync(file, '{ not json');
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(live.read().profiles).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(t.dir)).toEqual(['connections.json']);
  });
});
