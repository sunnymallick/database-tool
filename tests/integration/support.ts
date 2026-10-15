/**
 * Shared helpers for integration tests: temp dirs under tests/.tmp (gitignored),
 * profile builders, and a probe for the local Postgres test database.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import type { ConnectionProfile, DbKind } from '@shared/types';

export const ROOT = resolve(__dirname, '../..');
export const SAMPLE_SQLITE = join(ROOT, 'tests/fixtures/sample.sqlite');
export const PG_URL = process.env.DATABASE_TOOL_TEST_PG ?? 'postgres://localhost:5432/database_tool_test';

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const base = join(ROOT, 'tests/.tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A private copy of the SQLite fixture; the original is never opened for writing. */
export function sqliteCopy(dir: string): string {
  const path = join(dir, 'sample.sqlite');
  copyFileSync(SAMPLE_SQLITE, path);
  return path;
}

export function profile(kind: DbKind, overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  const now = new Date().toISOString();
  return {
    id: `test-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    name: `Test ${kind}`,
    kind,
    host: 'localhost',
    port: 0,
    database: '',
    username: '',
    filePath: '',
    ssl: false,
    trustServerCertificate: false,
    options: {},
    extraDatabases: [],
    color: null,
    group: null,
    production: false,
    readOnly: false,
    hasPassword: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

export function pgProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  const url = new URL(PG_URL);
  return profile('postgres', {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    username: decodeURIComponent(url.username),
    ...overrides
  });
}

/** True when the local Postgres test database accepts connections (suites skip otherwise). */
export async function pgAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM pg_namespace WHERE nspname = 'sales'`);
    return Number(rows[0].n) === 1;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Run admin SQL against the test database (scratch schema setup/teardown). */
export async function pgAdmin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
