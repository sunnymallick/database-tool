import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCodeStatus, installCli, uninstallCli } from '../../src/main/external/install';
import { tempDir } from '../integration/support';

describe('db-tool install', () => {
  let t: { dir: string; cleanup: () => void };
  let shimPath: string;
  let installPath: string;

  beforeEach(() => {
    t = tempDir('install');
    shimPath = join(t.dir, 'db-tool-shim');
    writeFileSync(shimPath, '');
    installPath = join(t.dir, 'home', '.local', 'bin', 'db-tool');
  });
  afterEach(() => t.cleanup());

  it('links, reports, and removes the command', () => {
    expect(claudeCodeStatus({ shimPath, installPath })).toMatchObject({ installed: false, conflict: null });
    const s = installCli({ shimPath, installPath });
    expect(s.installed).toBe(true);
    expect(lstatSync(installPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(installPath)).toBe(shimPath);
    expect(s.mcpCommand).toBe(`claude mcp add db-tool -- ${installPath} mcp`);

    expect(uninstallCli({ shimPath, installPath }).installed).toBe(false);
    expect(existsSync(installPath)).toBe(false);
  });

  it('never overwrites a regular file', () => {
    installCli({ shimPath, installPath });
    uninstallCli({ shimPath, installPath });
    writeFileSync(installPath, 'mine');
    expect(claudeCodeStatus({ shimPath, installPath }).conflict).toMatch(/not a link/);
    expect(() => installCli({ shimPath, installPath })).toThrow(/Move it away/);
    uninstallCli({ shimPath, installPath });
    expect(existsSync(installPath)).toBe(true);
  });

  it('refuses to install from source and gives a tsx command instead', () => {
    const s = claudeCodeStatus({ shimPath: null, sourceRoot: '/repo', installPath });
    expect(s.mcpCommand).toBe('claude mcp add db-tool -- /repo/node_modules/.bin/tsx --tsconfig /repo/tsconfig.node.json /repo/src/cli/index.ts mcp');
    expect(() => installCli({ shimPath: null, installPath })).toThrow(/packaged app/);
  });

  it('quotes paths with spaces', () => {
    const spaced = join(t.dir, 'my bin', 'db-tool');
    expect(claudeCodeStatus({ shimPath, installPath: spaced }).mcpCommand).toBe(`claude mcp add db-tool -- '${spaced}' mcp`);
  });

  it('keeps a link that belongs to something else, but replaces a dangling one', () => {
    const other = join(t.dir, 'other-tool');
    writeFileSync(other, '');
    mkdirSync(dirname(installPath), { recursive: true });
    symlinkSync(other, installPath);
    expect(claudeCodeStatus({ shimPath, installPath }).conflict).toMatch(/already links to/);
    expect(() => installCli({ shimPath, installPath })).toThrow(/Remove that link/);
    expect(readlinkSync(installPath)).toBe(other);

    const gone = join(t.dir, 'Old Database Tool.app-db-tool');
    const dangling = join(t.dir, 'home2', 'db-tool');
    mkdirSync(dirname(dangling), { recursive: true });
    symlinkSync(gone, dangling);
    expect(claudeCodeStatus({ shimPath, installPath: dangling }).conflict).toBeNull();
    expect(installCli({ shimPath, installPath: dangling }).installed).toBe(true);
  });
});
