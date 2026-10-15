import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertDbtoolProfile, mapDbtoolKind, planDbtoolImport, rgbToHex } from '../../src/main/connections/import-dbtool';
import type { CommandRunner } from '../../src/main/connections/secrets';
import { ROOT, profile, tempDir } from '../integration/support';

const FIXTURE = join(ROOT, 'tests/fixtures/dbtool-connections.json');
const id = (n: number) => `0d5c1f0e-${String(n).repeat(4)}-4a9b-9c3e-00000000000${n}`;

/** Fake `security`: knows one dbTool item; records every call. */
function fakeKeychain(behavior: Record<string, { code: number; stdout?: string }> = {}) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const account = args[args.indexOf('-a') + 1];
    const hit = behavior[account] ?? { code: 44 };
    return { code: hit.code, stdout: hit.stdout ?? '', stderr: hit.code === 44 ? 'The specified item could not be found in the keychain.' : '' };
  };
  return { runner, calls };
}

describe('dbTool importer', () => {
  const tmp = tempDir('dbtool-import');
  copyFileSync(FIXTURE, join(tmp.dir, 'connections.json'));
  afterAll(() => tmp.cleanup());

  it('maps kinds and colors', () => {
    expect(mapDbtoolKind('Postgres')).toBe('postgres');
    expect(mapDbtoolKind('MySql')).toBe('mysql');
    expect(mapDbtoolKind('MsSql')).toBe('mssql');
    expect(mapDbtoolKind('Sqlite')).toBe('sqlite');
    expect(mapDbtoolKind('Oracle')).toBeNull();
    expect(rgbToHex([52, 120, 246])).toBe('#3478f6');
    expect(rgbToHex([300, -1, 0])).toBe('#ff0000');
    expect(rgbToHex('red')).toBeNull();
    expect(convertDbtoolProfile({ name: '', kind: 'Postgres' })).toBe('profile has no name');
  });

  it('imports profiles, skips duplicates and unsupported kinds, and reads Keychain passwords', async () => {
    const kc = fakeKeychain({ [id(7)]: { code: 0, stdout: 'billing-pw\n' } });
    const plan = await planDbtoolImport({ configDir: tmp.dir, existing: [], includePasswords: true, runner: kc.runner });

    expect(plan.sourcePath).toBe(join(tmp.dir, 'connections.json'));
    expect(plan.items.map((i) => i.profile.name)).toEqual(['Local Postgres', 'Orders (prod)', 'Legacy MySQL via bastion', 'Scratch SQLite', 'Billing', 'Reporting replica']);
    expect(plan.skipped).toEqual([
      { name: 'Local Postgres (copy)', reason: 'same server, database, and user as "Local Postgres"' },
      { name: 'Warehouse', reason: 'unsupported database kind "Oracle"' }
    ]);

    const byName = Object.fromEntries(plan.items.map((i) => [i.profile.name, i]));
    expect(byName['Local Postgres'].profile).toMatchObject({
      kind: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'app_dev',
      username: 'dev',
      ssl: false,
      color: '#3478f6',
      extraDatabases: ['app_test', 'analytics'],
      production: false,
      readOnly: false
    });
    expect(byName['Local Postgres'].password).toBe('dev-secret');
    expect(byName['Orders (prod)'].profile).toMatchObject({ kind: 'mssql', ssl: true, trustServerCertificate: true, production: true, readOnly: true, color: '#dc2626' });
    expect(byName['Orders (prod)'].password).toBeNull();
    expect(byName['Scratch SQLite'].profile).toMatchObject({ kind: 'sqlite', filePath: '/tmp/scratch.db', database: '', host: '' });
    expect(byName.Billing.profile.port).toBe(1433);
    expect(byName.Billing.password).toBe('billing-pw');
    expect(byName['Reporting replica'].profile).toMatchObject({ port: 5433, readOnly: true });
    // Every imported profile gets a fresh id.
    expect(new Set(plan.items.map((i) => i.profile.id)).size).toBe(6);
    expect(plan.items.some((i) => i.profile.id.startsWith('0d5c1f0e'))).toBe(false);

    // Keychain is only asked for server profiles without a plaintext fallback.
    expect(kc.calls.map((c) => c[c.indexOf('-a') + 1])).toEqual([id(2), id(3), id(7), id(8)]);
    expect(kc.calls[0]).toEqual(['/usr/bin/security', 'find-generic-password', '-s', 'dbTool', '-a', id(2), '-w']);

    expect(plan.warnings).toEqual([expect.objectContaining({ name: 'Legacy MySQL via bastion', message: expect.stringContaining('SSH tunnel via bastion.example.com') })]);
  });

  it('stops prompting after the first Keychain denial', async () => {
    const kc = fakeKeychain({ [id(2)]: { code: 51 }, [id(7)]: { code: 0, stdout: 'never-read' } });
    const plan = await planDbtoolImport({ configDir: tmp.dir, existing: [], includePasswords: true, runner: kc.runner });
    expect(kc.calls).toHaveLength(1);
    expect(plan.items.find((i) => i.profile.name === 'Billing')?.password).toBeNull();
    expect(plan.warnings.find((w) => w.name === 'Keychain')?.message).toMatch(/4 passwords were not imported/);
  });

  it('does not touch the Keychain unless asked, and explains when it cannot', async () => {
    const kc = fakeKeychain();
    const plan = await planDbtoolImport({ configDir: tmp.dir, existing: [], includePasswords: false, runner: kc.runner });
    expect(kc.calls).toHaveLength(0);
    expect(plan.items.filter((i) => i.password !== null).map((i) => i.profile.name)).toEqual(['Local Postgres']);
    const noRunner = await planDbtoolImport({ configDir: tmp.dir, existing: [], includePasswords: true });
    expect(noRunner.warnings.find((w) => w.name === 'Keychain')?.message).toMatch(/only be copied from the macOS Keychain/);
  });

  it('skips names and endpoints that already exist', async () => {
    const existing = [
      profile('mssql', { name: 'billing', host: 'other.example.com' }),
      profile('postgres', { name: 'Mine', host: 'replica.example.com', port: 5433, database: 'reporting', username: 'reader' })
    ];
    const plan = await planDbtoolImport({ configDir: tmp.dir, existing, includePasswords: false });
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { name: 'Billing', reason: 'a connection with this name already exists' },
        { name: 'Reporting replica', reason: 'same server, database, and user as "Mine"' }
      ])
    );
  });

  it('reports a missing or malformed source file', async () => {
    const empty = tempDir('dbtool-empty');
    try {
      await expect(planDbtoolImport({ configDir: empty.dir, existing: [], includePasswords: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      empty.cleanup();
    }
  });
});
