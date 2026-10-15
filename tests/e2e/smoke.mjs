// End-to-end smoke test: launches the built Electron app with an isolated
// data dir and exercises the real IPC surface (SQLite fixture copy + local
// Postgres `database_tool_test`), then screenshots the UI.
//
//   pnpm test:e2e            (builds first)
//   SMOKE_SHOTS=dir node tests/e2e/smoke.mjs
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchApp } from './launch.mjs';

const shots = process.env.SMOKE_SHOTS ?? mkdtempSync(join(tmpdir(), 'database-tool-shots-'));
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'database-tool-smoke-'));
const sqliteCopy = join(work, 'sample.sqlite');
copyFileSync(resolve('tests/fixtures/sample.sqlite'), sqliteCopy);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};

const { app, page, home } = await launchApp();
const invoke = (method, req) =>
  page.evaluate(
    async ([m, r]) => {
      const res = await window.bridge.invoke(m, r);
      return res;
    },
    [method, req]
  );
const ok = async (method, req) => {
  const res = await invoke(method, req);
  if (!res.ok) throw new Error(`${method}: ${res.error.message}`);
  return res.data;
};

const now = new Date().toISOString();
const baseProfile = {
  host: '', port: 0, database: '', username: '', filePath: '', ssl: false, trustServerCertificate: false,
  options: {}, extraDatabases: [], color: null, group: null, production: false, readOnly: false,
  hasPassword: false, createdAt: now, updatedAt: now
};

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, '01-first-run.png') });

  // --- SQLite ---------------------------------------------------------------
  const sqlite = await ok('connections.save', {
    profile: { ...baseProfile, id: crypto.randomUUID(), name: 'Sample (SQLite)', kind: 'sqlite', filePath: sqliteCopy }
  });
  check('save sqlite profile', !!sqlite.id);
  const conn = { profileId: sqlite.id };
  const st = await ok('connections.connect', conn);
  check('connect sqlite', st.state === 'connected', st.error ?? st.serverVersion);
  const schemas = await ok('db.schemas', { conn });
  const tables = await ok('db.tables', { conn, schema: schemas.defaultSchema });
  check('sqlite tables listed', tables.some((t) => t.name === 'orders') && tables.some((t) => t.kind === 'view'), tables.map((t) => t.name).join(','));
  const structure = await ok('db.structure', { conn, schema: schemas.defaultSchema, table: 'order_items' });
  check('sqlite structure: composite PK + FKs', structure.primaryKey.length === 2 && structure.foreignKeys.length === 2);
  const q = await ok('db.query', { conn, sql: "SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status;\nSELECT * FROM customers WHERE id <= 3", queryId: crypto.randomUUID() });
  check('sqlite multi-statement query', !q.error && q.results.length === 2 && q.results[0].rows.length === 5, q.error?.message);
  check('single-table select is editable', !!q.results[1]?.editable, JSON.stringify(q.results[1]?.editable));
  const bad = await ok('db.query', { conn, sql: 'SELECT 1;\nSELECT * FROM nope', queryId: crypto.randomUUID() });
  check('error reported with partial results', !!bad.error && bad.results.length === 1 && bad.error.statementIndex === 1, bad.error?.message);
  const page1 = await ok('db.rows', { table: { conn, schema: schemas.defaultSchema, table: 'customers' }, limit: 50, offset: 0, countTotal: true, orderBy: [{ column: 'id', desc: true }] });
  check('paged rows + total', page1.result.rows.length === 50 && page1.total === 200);
  const changes = { updates: [{ pk: { id: { t: 'int', v: '1' } }, set: { country: { t: 'text', v: 'ZZ' } } }], inserts: [], deletes: [] };
  const preview = await ok('db.applyChanges', { table: { conn, schema: schemas.defaultSchema, table: 'customers' }, changes, preview: true });
  check('applyChanges preview renders SQL', preview.statements.length === 1 && /UPDATE/i.test(preview.statements[0]), preview.statements[0]);
  const applied = await ok('db.applyChanges', { table: { conn, schema: schemas.defaultSchema, table: 'customers' }, changes, preview: false });
  const after = await ok('db.query', { conn, sql: 'SELECT country FROM customers WHERE id = 1', queryId: crypto.randomUUID() });
  check('applyChanges applied', applied.applied === 1 && after.results[0].rows[0][0].v === 'ZZ');
  const history = await ok('history.list', { limit: 10 });
  check('history recorded', history.length >= 3);

  // Read-only guard
  const ro = await ok('connections.save', { profile: { ...sqlite, id: crypto.randomUUID(), name: 'RO', readOnly: true } });
  const roConn = { profileId: ro.id };
  await ok('connections.connect', roConn);
  const roRes = await invoke('db.query', { conn: roConn, sql: "UPDATE customers SET country = 'XX'", queryId: crypto.randomUUID() });
  const roBlocked = (roRes.ok && !!roRes.data.error) || !roRes.ok;
  check('read-only profile blocks writes', roBlocked);

  // --- Postgres -------------------------------------------------------------
  const pgp = await ok('connections.save', {
    profile: { ...baseProfile, id: crypto.randomUUID(), name: 'Shop (local Postgres)', kind: 'postgres', host: 'localhost', port: 5432, database: 'database_tool_test', username: process.env.USER ?? 'postgres' },
    password: null
  });
  const pconn = { profileId: pgp.id };
  const pst = await ok('connections.connect', pconn);
  check('connect postgres', pst.state === 'connected', pst.error ?? pst.serverVersion);
  const pschemas = await ok('db.schemas', { conn: pconn });
  check('pg schemas', pschemas.schemas.includes('sales') && pschemas.defaultSchema === 'public', pschemas.schemas.join(','));
  const ptables = await ok('db.tables', { conn: pconn, schema: 'sales' });
  check('pg tables incl. matview', ptables.some((t) => t.kind === 'materialized_view'), ptables.map((t) => `${t.name}:${t.kind}`).join(','));
  const pq = await ok('db.query', { conn: pconn, sql: 'SELECT id, external_id, metadata, tags, created_at, is_active FROM customers ORDER BY id LIMIT 5', queryId: crypto.randomUUID() });
  const row = pq.results[0]?.rows[0] ?? [];
  check('pg value tags', row[0]?.t === 'int' && row[2] && ['json', 'null'].includes(row[2].t) && row[3]?.t === 'json' && row[4]?.t === 'datetime' && row[5]?.t === 'bool', row.map((v) => v.t).join(','));
  const ddl = await ok('db.ddl', { conn: pconn, schema: 'sales', table: 'orders' });
  check('pg DDL', /CREATE TABLE/i.test(ddl) && /REFERENCES/i.test(ddl));
  const qid = crypto.randomUUID();
  const slow = invoke('db.query', { conn: pconn, sql: 'SELECT pg_sleep(20)', queryId: qid });
  await page.waitForTimeout(700);
  await ok('db.cancel', { queryId: qid });
  const slowRes = await slow;
  check('pg cancel', slowRes.ok && (slowRes.data.cancelled || !!slowRes.data.error), JSON.stringify(slowRes.ok ? slowRes.data.error : slowRes.error));
  const meta = await ok('db.meta', { conn: pconn });
  check('pg meta for completion', meta.tables.length >= 6);

  // --- Files allowlist -------------------------------------------------------
  const denied = await invoke('files.read', { path: '/etc/hosts' });
  check('files.read outside allowlist denied', !denied.ok && denied.error.code === 'FORBIDDEN');

  // --- AI status -------------------------------------------------------------
  const ai = await invoke('ai.status', {});
  check('ai.status answers', ai.ok, ai.ok ? `${ai.data.available} ${ai.data.version ?? ''} ${ai.data.cliPath ?? ''}` : ai.error.message);

  // --- UI screenshots --------------------------------------------------------
  await page.reload();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(shots, '02-with-connections.png') });
} catch (err) {
  failures++;
  console.log('FAIL  smoke crashed:', err.message);
} finally {
  await app.close();
}

console.log(`\nscreenshots: ${shots}\ndata dir: ${home}\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
