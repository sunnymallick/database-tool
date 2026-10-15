// End-to-end check of opening .sql files and exporting results, with the
// native dialogs stubbed in the main process (they can't be clicked by
// automation). Verifies: multi-file open, "Export all" to CSV files (never
// overwriting), to one .xlsx workbook, single-result Excel export, and that
// save dialogs reopen in the last folder used this session.
//
//   pnpm build && node tests/e2e/files.mjs
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { launchApp } from './launch.mjs';

const work = mkdtempSync(join(tmpdir(), 'dt-files-'));
const db = join(work, 'sample.sqlite');
copyFileSync(resolve('tests/fixtures/sample.sqlite'), db);
const sqlDir = join(work, 'queries');
const outDir = join(work, 'exports');
mkdirSync(sqlDir);
mkdirSync(outDir);
writeFileSync(join(sqlDir, 'customers.sql'), 'SELECT * FROM customers LIMIT 5;\n');
writeFileSync(join(sqlDir, 'orders.sql'), 'SELECT status, count(*) AS n FROM orders GROUP BY status;\n');
const shots = process.env.FILES_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) failures++;
};

const { app, page } = await launchApp();
const shot = (n) => (shots ? page.screenshot({ path: join(shots, `${n}.png`) }) : Promise.resolve());
const invoke = async (m, r) => {
  const res = await page.evaluate(([m, r]) => window.bridge.invoke(m, r), [m, r]);
  if (!res.ok) throw new Error(`${m}: ${res.error.message}`);
  return res.data;
};
// Background tabs stay mounted, so only consider what is on screen.
const visible = (locator) => locator.filter({ visible: true });
const treeItem = (t) => page.locator('[role=treeitem]').filter({ has: page.getByText(t, { exact: true }) }).first();

// Replace the native dialogs with a queue of canned answers and record what each was asked.
await app.evaluate(({ dialog }) => {
  globalThis.__calls = [];
  globalThis.__queue = [];
  const answer = (kind, a, b) => {
    const opts = b ?? a ?? {};
    globalThis.__calls.push({ kind, defaultPath: opts.defaultPath ?? null, properties: opts.properties ?? [] });
    return globalThis.__queue.shift();
  };
  dialog.showOpenDialog = async (a, b) => answer('open', a, b) ?? { canceled: true, filePaths: [] };
  dialog.showSaveDialog = async (a, b) => answer('save', a, b) ?? { canceled: true };
});
const queue = (resp) => app.evaluate((_e, r) => globalThis.__queue.push(r), resp);
const lastCall = () => app.evaluate(() => globalThis.__calls.at(-1));

try {
  await page.waitForLoadState('domcontentloaded');
  const now = new Date().toISOString();
  await invoke('connections.save', {
    profile: { id: '', name: 'Sample', kind: 'sqlite', host: '', port: 0, database: '', username: '', filePath: db, ssl: false, trustServerCertificate: false, options: {}, extraDatabases: [], color: null, group: null, production: false, readOnly: false, hasPassword: false, createdAt: now, updatedAt: now }
  });
  await page.reload();
  await page.waitForTimeout(1200);
  await treeItem('Sample').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /New query/i }).click();
  await page.waitForTimeout(600);

  // -- open two .sql files from the empty query window ---------------------------------
  check('open button shown in an empty query window', (await visible(page.getByTestId('open-sql-empty')).count()) === 1);
  await queue({ canceled: false, filePaths: [join(sqlDir, 'customers.sql'), join(sqlDir, 'orders.sql')] });
  await visible(page.getByRole('button', { name: 'Open .sql files' })).click();
  await page.waitForTimeout(800);
  const open1 = await lastCall();
  check('open dialog allows several files', open1.properties.includes('multiSelections'));
  const tabText = await page.locator('body').innerText();
  check('both files opened in tabs', /customers\.sql/.test(tabText) && /orders\.sql/.test(tabText));
  check('first file reused the empty tab', (await visible(page.locator('.cm-content')).innerText()).includes('FROM customers'));
  await shot('01-opened-files');

  // -- run three statements, export all as CSV files -------------------------------------
  await treeItem('Sample').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /New query/i }).click();
  await page.waitForTimeout(600);
  await visible(page.locator('.cm-content')).click();
  await page.keyboard.type('SELECT * FROM customers LIMIT 3;\nSELECT status, count(*) AS n FROM orders GROUP BY status;\nSELECT 1 AS one, NULL AS missing, 1.5 AS x');
  await page.keyboard.press('Meta+Shift+Enter');
  await visible(page.getByTestId('export-all-results')).waitFor({ timeout: 10000 });
  check('"Export all 3" offered', /Export all 3/.test(await visible(page.getByTestId('export-all-results')).innerText()));

  await queue({ canceled: false, filePaths: [outDir] });
  await visible(page.getByTestId('export-all-results')).click();
  await page.getByRole('menuitem', { name: /CSV files/ }).click();
  await page.waitForTimeout(1200);
  let files = readdirSync(outDir).sort();
  check('three CSV files written', files.length === 3, files.join(' | '));
  const customersCsv = files.find((f) => f.includes('customers'));
  check('CSV content has header + rows', !!customersCsv && readFileSync(join(outDir, customersCsv), 'utf8').split('\r\n')[0].startsWith('id,email'));
  await shot('02-exported-csv');

  await queue({ canceled: false, filePaths: [outDir] });
  await visible(page.getByTestId('export-all-results')).click();
  await page.getByRole('menuitem', { name: /CSV files/ }).click();
  await page.waitForTimeout(1200);
  files = readdirSync(outDir).sort();
  check('second export never overwrites', files.length === 6 && files.some((f) => f.includes(' (2).csv')), files.join(' | '));

  // -- export all as one workbook: the save dialog starts in the last folder ---------------
  await queue({ canceled: false, filePath: join(outDir, 'all-results.xlsx') });
  await visible(page.getByTestId('export-all-results')).click();
  await page.getByRole('menuitem', { name: /Excel workbook/ }).click();
  await page.waitForTimeout(1500);
  const save1 = await lastCall();
  check('save dialog opens in the last export folder', save1.defaultPath?.startsWith(outDir + '/') && save1.defaultPath.endsWith('.xlsx'), save1.defaultPath);
  const wb = unzipSync(readFileSync(join(outDir, 'all-results.xlsx')));
  const wbXml = strFromU8(wb['xl/workbook.xml']);
  const sheets = [...wbXml.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  check('workbook has one sheet per result + Queries', sheets.length === 4 && sheets.at(-1) === 'Queries', sheets.join(' | '));

  // -- single result as Excel from the grid's Export menu -------------------------------------
  await queue({ canceled: false, filePath: join(outDir, 'one.xlsx') });
  await visible(page.getByRole('button', { name: /^Export$/ })).click();
  await page.getByRole('menuitem', { name: /Excel \(\.xlsx\)/ }).first().click();
  await page.waitForTimeout(1200);
  const save2 = await lastCall();
  check('single-result Excel export', readdirSync(outDir).includes('one.xlsx') && save2.defaultPath?.startsWith(outDir + '/'), save2.defaultPath);
  await shot('03-after-exports');

  // -- AI input: tall enough and the editor chip never overlaps the text ---------------------
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('api:event', 'menu', 'toggle-ai'));
  const input = page.getByTestId('ai-input');
  await input.waitFor({ timeout: 10000 });
  await input.click();
  await input.fill('line one\nline two\nline three');
  await page.waitForTimeout(300);
  const box = await input.boundingBox();
  const chip = await page.getByTestId('ai-include-editor').boundingBox();
  check('AI input is at least ~4 lines tall', box.height >= 80, `${Math.round(box.height)}px`);
  check('editor chip sits below the text', chip.y >= box.y + box.height - 1, `input bottom ${Math.round(box.y + box.height)}, chip top ${Math.round(chip.y)}`);
  await shot('04-ai-input');
} catch (err) {
  failures++;
  console.log('FAIL  crashed:', err.message.split('\n')[0]);
  await shot('crash');
} finally {
  await app.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
