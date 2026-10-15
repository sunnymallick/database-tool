import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Directory for profiles, history, snippets, settings, and session state.
 * Override with DATABASE_TOOL_HOME (tests and smoke runs must set it to a temp dir).
 */
export function dataDir(): string {
  const override = process.env.DATABASE_TOOL_HOME;
  if (override) return override;
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'database-tool');
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'database-tool');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'database-tool');
  }
}

export function dataFile(name: string): string {
  return join(dataDir(), name);
}

/** dbTool's config directory, read by the profile importer. Override with DBTOOL_CONFIG_DIR. */
export function dbtoolConfigDir(): string {
  const override = process.env.DBTOOL_CONFIG_DIR;
  if (override) return override;
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'dbTool');
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'dbTool');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'dbTool');
  }
}
