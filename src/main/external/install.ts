/**
 * Installing the db-tool command: a symlink from ~/.local/bin/db-tool to the
 * shim inside the app bundle (no sudo, survives app updates in place).
 * Electron-free so it can be unit-tested; ipc/claude-code.ts supplies the paths.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ClaudeCodeStatus } from '@shared/types';
import { AppError } from '../errors';
import { dataFile } from '../paths';
import { AUDIT_FILE } from './audit';

export interface InstallPaths {
  /** The bundled shim, or null when running from source. */
  shimPath: string | null;
  /** Repository root, used for the from-source MCP command. */
  sourceRoot?: string;
  installPath?: string;
}

export const defaultInstallPath = (): string => join(homedir(), '.local', 'bin', 'db-tool');

/** Quote for a POSIX shell when needed. */
function sh(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function linkTarget(path: string): string | null | undefined {
  try {
    const st = lstatSync(path);
    if (!st.isSymbolicLink()) return null; // a regular file or directory
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return undefined; // nothing there
  }
}

export function claudeCodeStatus(paths: InstallPaths): ClaudeCodeStatus {
  const installPath = paths.installPath ?? defaultInstallPath();
  const target = linkTarget(installPath);
  const installed = !!paths.shimPath && target === resolve(paths.shimPath);
  let conflict: string | null = null;
  if (target === null) conflict = `${installPath} already exists and is not a link to Database Tool.`;
  // A link to something that still exists belongs to someone else; a dangling one (old app location) is replaced.
  else if (target && !installed && existsSync(target)) conflict = `${installPath} already links to ${target}.`;

  let command: string;
  if (paths.shimPath) command = `${sh(installPath)} mcp`;
  else {
    const root = paths.sourceRoot ?? process.cwd();
    command = `${sh(join(root, 'node_modules/.bin/tsx'))} --tsconfig ${sh(join(root, 'tsconfig.node.json'))} ${sh(join(root, 'src/cli/index.ts'))} mcp`;
  }
  return {
    shimPath: paths.shimPath,
    installPath,
    installed,
    conflict,
    mcpCommand: `claude mcp add db-tool -- ${command}`,
    auditFile: dataFile(AUDIT_FILE)
  };
}

export function installCli(paths: InstallPaths): ClaudeCodeStatus {
  if (!paths.shimPath) throw new AppError('The command can only be installed from the packaged app.', 'NOT_PACKAGED');
  const installPath = paths.installPath ?? defaultInstallPath();
  const target = linkTarget(installPath);
  if (target === null) throw new AppError(`${installPath} already exists and is not a link. Move it away first.`, 'EXISTS');
  if (target && target !== resolve(paths.shimPath) && existsSync(target)) {
    throw new AppError(`${installPath} already links to ${target}. Remove that link first.`, 'EXISTS');
  }
  mkdirSync(dirname(installPath), { recursive: true });
  if (target !== undefined) unlinkSync(installPath); // replace our own or a dangling link
  symlinkSync(paths.shimPath, installPath);
  return claudeCodeStatus(paths);
}

export function uninstallCli(paths: InstallPaths): ClaudeCodeStatus {
  const status = claudeCodeStatus(paths);
  if (status.installed) unlinkSync(status.installPath);
  return claudeCodeStatus(paths);
}
