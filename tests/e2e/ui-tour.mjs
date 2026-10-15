// UI tour: drives the built Electron app through the main flows against the
// SQLite fixture and local Postgres, screenshotting each step. Optional live
// AI turn (uses the Claude subscription): UI_TOUR_AI=1.
//
//   pnpm build && UI_TOUR_SHOTS=/tmp/shots node tests/e2e/ui-tour.mjs
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchApp } from './launch.mjs';

const shots = process.env.UI_TOUR_SHOTS ?? mkdtempSync(join(tmpdir(), 'database-tool-tour-'));
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'database-tool-tour-db-'));
const sqliteCopy = join(work, 'sample.sqlite');
copyFileSync(resolve('tests/fixtures/sample.sqlite'), sqliteCopy);

const { app, page } = await launchApp();
let failures = 0;
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
async function step(name, fn) {
  try {
    await fn();
    console.log(`OK    ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}: ${err.message.split('\n')[0]}`);
    await shot(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {});
  }
}
const invoke = async (method, req) => {
  const res = await page.evaluate(([m, r]) => window.bridge.invoke(m, r), [method, req]);
  if (!res.ok) throw new Error(`${method}: ${res.error.message}`);
  return res.data;
};
const menu = (action) =>
  app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send('api:event', 'menu', a), action);
const treeItem = (text) =>
  page.locator('[role=treeitem]').filter({ has: page.getByText(text, { exact: true }) }).first();

const now = new Date().toISOString();
const base = {
  host: '', port: 0, database: '', username: '', filePath: '', ssl: false, trustServerCertificate: false, options: {},
  extraDatabases: [], color: null, group: null, production: false, readOnly: false, hasPassword: false, createdAt: now, updatedAt: now
};

try {
  await page.waitForLoadState('domcontentloaded');
  await step('seed profiles', async () => {
    await invoke('connections.save', {
      profile: { ...base, id: '', name: 'Shop (local Postgres)', kind: 'postgres', host: 'localhost', port: 5432, database: 'database_tool_test', username: process.env.USER, color: '#4f8cff' },
      password: null
    });
    await invoke('connections.save', { profile: { ...base, id: '', name: 'Sample (SQLite)', kind: 'sqlite', filePath: sqliteCopy, color: '#43b883' } });
    await invoke('connections.save', { profile: { ...base, id: '', name: 'Reporting (prod copy)', kind: 'sqlite', filePath: sqliteCopy, production: true, group: 'Production' } });
    await invoke('settings.update', { aiModel: 'claude-haiku-5-5' });
    await page.reload();
    await page.waitForTimeout(1500);
  });

  await step('expand postgres tree', async () => {
    await treeItem('Shop (local Postgres)').dblclick();
    await treeItem('sales').waitFor({ timeout: 15000 });
    await treeItem('sales').dblclick();
    await page.waitForTimeout(800);
    await shot('01-tree');
  });

  await step('open orders data tab', async () => {
    const tablesGroup = page.locator('[role=treeitem]').filter({ hasText: /^\s*Tables/ });
    if ((await treeItem('orders').count()) === 0 && (await tablesGroup.count()) > 0) await tablesGroup.last().dblclick();
    await treeItem('orders').waitFor({ timeout: 10000 });
    await treeItem('orders').dblclick();
    await page.waitForTimeout(2500);
    await shot('02-table-data');
  });

  await step('structure view', async () => {
    const tab = page.getByRole('tab', { name: /structure/i }).or(page.getByRole('button', { name: /^structure$/i }));
    await tab.first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    await shot('03-structure');
  });

  await step('query tab with results', async () => {
    await menu('new-query');
    await page.waitForTimeout(800);
    await page.locator('.cm-content').last().click();
    await page.keyboard.type(
      'SELECT o.status, count(*) AS orders, sum(o.total) AS revenue\nFROM sales.orders o\nGROUP BY o.status\nORDER BY revenue DESC;\n\nSELECT * FROM customers ORDER BY id LIMIT 200;'
    );
    await page.keyboard.press('Meta+Shift+Enter');
    await page.waitForTimeout(2500);
    await shot('04-query-results');
  });

  await step('query error', async () => {
    await page.keyboard.press('Meta+a');
    await page.keyboard.type('SELECT id, emial FROM customers');
    await page.keyboard.press('Meta+Enter');
    await page.waitForTimeout(1500);
    await shot('05-query-error');
  });

  await step('production connection styling', async () => {
    await treeItem('Reporting (prod copy)').click();
    await treeItem('Reporting (prod copy)').click({ button: 'right' });
    await page.waitForTimeout(500);
    await shot('06-context-menu');
    await page.keyboard.press('Escape');
    await menu('new-query');
    await page.waitForTimeout(1000);
    await shot('07-production-tab');
  });

  await step('connection dialog', async () => {
    await menu('new-connection');
    await page.waitForTimeout(800);
    await shot('08-connection-dialog');
    await page.keyboard.press('Escape');
  });

  await step('settings dialog', async () => {
    await menu('open-settings');
    await page.waitForTimeout(800);
    await shot('09-settings');
    await page.keyboard.press('Escape');
  });

  await step('ai panel', async () => {
    await page.getByText('Query', { exact: false }).first().waitFor();
    await menu('toggle-ai');
    await page.waitForTimeout(2500);
    await shot('10-ai-panel');
  });

  if (process.env.UI_TOUR_AI === '1') {
    await step('live ai turn', async () => {
      const input = page.locator('textarea').last();
      await input.click();
      await input.fill('How many customers are there, and which country has the most? Answer in one short sentence.');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /\b200\b/.test(document.body.innerText) && !/\bStop\b/.test(document.body.innerText), null, { timeout: 120000 });
      await page.waitForTimeout(1000);
      await shot('11-ai-answer');
    });
  }

  await step('light theme', async () => {
    await invoke('settings.update', { theme: 'light' });
    await page.waitForTimeout(1000);
    await shot('12-light-theme');
  });
} finally {
  await app.close();
}
console.log(`\nscreenshots: ${shots}\n${failures === 0 ? 'ALL OK' : `${failures} step(s) failed`}`);
process.exitCode = failures ? 1 : 0;
