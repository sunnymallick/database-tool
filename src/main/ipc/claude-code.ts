/**
 * claudeCode.* handlers: status, install, and uninstall of the db-tool
 * command for Settings > Claude Code.
 */
import { app } from 'electron';
import { join, resolve } from 'node:path';
import { claudeCodeStatus, installCli, uninstallCli, type InstallPaths } from '../external/install';
import type { Router } from './types';

function paths(): InstallPaths {
  if (app.isPackaged) return { shimPath: join(process.resourcesPath, 'bin', 'db-tool') };
  // From source: out/main/index.js -> repository root.
  return { shimPath: null, sourceRoot: resolve(app.getAppPath()) };
}

export function registerClaudeCodeHandlers(r: Router): void {
  r.handle('claudeCode.status', () => claudeCodeStatus(paths()));
  r.handle('claudeCode.installCli', () => installCli(paths()));
  r.handle('claudeCode.uninstallCli', () => uninstallCli(paths()));
}
