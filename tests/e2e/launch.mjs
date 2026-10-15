// Shared helper: launch the built Electron app with an isolated data dir.
import { _electron as electron } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export async function launchApp({ dataDir } = {}) {
  const home = dataDir ?? mkdtempSync(join(tmpdir(), 'database-tool-e2e-'));
  const env = { ...process.env, DATABASE_TOOL_HOME: home };
  // Never let a nested Claude Code session leak into the app's AI subprocess.
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  const app = await electron.launch({ args: [resolve('.')], env });
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[renderer:${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[renderer:pageerror] ${e.message}`));
  return { app, page, home };
}
