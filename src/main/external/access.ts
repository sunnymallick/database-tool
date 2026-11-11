/**
 * Which connections Claude Code (the db-tool MCP server and CLI) may use.
 *
 * The rules live here and nowhere else:
 *  - only profiles with `claudeCodeAccess` on are visible;
 *  - `--connections` / DB_TOOL_CONNECTIONS can narrow that set, never widen it;
 *  - every visible profile is forced read-only, so the registry opens a
 *    read-only session (where the engine supports it) and wraps the driver in
 *    the same keyword guard the app uses for read-only connections;
 *  - only plain reads can run: every statement must start with an allowlisted
 *    keyword (no BEGIN/COMMIT, SET, USE, DECLARE, ...) on top of the app's
 *    read-only check, so a session can't be switched to read-write or to
 *    another database;
 *  - the profile's default and additional databases are the only connection
 *    targets. On SQL Server and MySQL a query can still name another database
 *    on the same server (`otherdb.dbo.t`); the login's own permissions are the
 *    boundary there.
 */
import { containsKeyword, isReadOnlyScript, leadingKeyword, splitStatements } from '@shared/sql';
import type { ConnRef, ConnectionProfile, DbKind } from '@shared/types';
import { AppError } from '../errors';

export const NOT_EXPOSED_CODE = 'NOT_EXPOSED';

/** Names or ids a process is limited to; empty means every exposed profile. */
export type ConnectionScope = readonly string[];

/** Parse a comma-separated `--connections` value. */
export function parseScope(raw: string | undefined): ConnectionScope {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const matches = (p: ConnectionProfile, key: string): boolean => p.id === key || p.name.toLowerCase() === key.toLowerCase();

/** The profiles this process may see, each forced read-only. */
export function exposedProfiles(all: readonly ConnectionProfile[], scope: ConnectionScope = []): ConnectionProfile[] {
  return all
    .filter((p) => p.claudeCodeAccess === true)
    .filter((p) => scope.length === 0 || scope.some((key) => matches(p, key)))
    .map((p) => ({ ...p, readOnly: true, options: { ...p.options }, extraDatabases: [...p.extraDatabases] }));
}

function notExposed(key: string, exposed: readonly ConnectionProfile[]): AppError {
  const names = exposed.map((p) => p.name);
  const list = names.length ? ` Available: ${names.map((n) => `"${n}"`).join(', ')}.` : ' No connections are shared right now.';
  return new AppError(
    `No connection "${key}" is shared with Claude Code.${list} ` +
      'To share one, open it in Database Tool and turn on "Claude Code access" under Safety.',
    NOT_EXPOSED_CODE
  );
}

/** Find an exposed profile by id or by name (case-insensitive). */
export function resolveProfile(exposed: readonly ConnectionProfile[], key: string): ConnectionProfile {
  const k = key.trim();
  if (!k) throw new AppError('A connection name is required. List them with list_connections (or `db-tool connections`).', 'BAD_REQUEST');
  const byId = exposed.find((p) => p.id === k);
  if (byId) return byId;
  const byName = exposed.filter((p) => p.name.toLowerCase() === k.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new AppError(
      `Several shared connections are named "${k}". Use an id instead: ${byName.map((p) => p.id).join(', ')}.`,
      'AMBIGUOUS'
    );
  }
  throw notExposed(k, exposed);
}

/** Databases a profile may target: its default plus the additional ones shown in the sidebar. */
export function allowedDatabases(profile: ConnectionProfile): string[] {
  if (profile.kind === 'sqlite') return [];
  return [profile.database, ...profile.extraDatabases].filter(Boolean);
}

/** Build the ConnRef for a profile and an optional database, refusing databases that are not configured. */
export function connRefFor(profile: ConnectionProfile, database?: string): ConnRef {
  const db = database?.trim();
  if (!db || profile.kind === 'sqlite') return { profileId: profile.id };
  const allowed = allowedDatabases(profile);
  const hit = allowed.find((d) => d.toLowerCase() === db.toLowerCase());
  if (!hit) {
    const list = allowed.length ? allowed.map((d) => `"${d}"`).join(', ') : '(only the server default)';
    throw new AppError(
      `"${profile.name}" is not set up for database "${db}". Configured databases: ${list}. ` +
        'Add it under "Additional databases" in the connection settings to use it here.',
      NOT_EXPOSED_CODE
    );
  }
  return hit === profile.database ? { profileId: profile.id } : { profileId: profile.id, database: hit };
}

/** Statement types Claude Code may run. Anything else (transaction control, SET, USE, DECLARE, EXEC, ...) is refused. */
const READ_STARTERS = new Set(['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'PRAGMA']);

/**
 * T-SQL runs several statements without any separator (`SELECT 1 USE master`),
 * so on SQL Server these words are refused anywhere outside strings, quoted
 * names, and comments. All are reserved words in T-SQL, so a bare one can
 * only be a statement, never a column or table name.
 */
const MSSQL_STATEMENT_WORDS = [
  'USE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE', 'SET', 'DECLARE', 'EXEC', 'EXECUTE', 'IF', 'WHILE', 'GOTO', 'WAITFOR',
  'GRANT', 'REVOKE', 'DENY', 'KILL', 'SHUTDOWN', 'RECONFIGURE', 'DBCC', 'BACKUP', 'RESTORE', 'OPENROWSET',
  'OPENQUERY', 'OPENDATASOURCE'
];

/**
 * Why `sql` may not run for an external caller, or null when every statement
 * is a plain read. Stricter than the app's read-only guard on purpose.
 */
export function externalReadRefusal(sql: string, kind: DbKind): string | null {
  if (kind === 'mssql') {
    const word = MSSQL_STATEMENT_WORDS.find((w) => containsKeyword(sql, w, kind));
    if (word) {
      return `${word} is not allowed: connections shared with Claude Code are read-only and only run plain reads (SELECT, WITH ... SELECT).`;
    }
  }
  for (const st of splitStatements(sql, kind)) {
    const keyword = leadingKeyword(st.text, kind);
    if (!READ_STARTERS.has(keyword)) {
      return `${keyword || 'This'} statements are not allowed: connections shared with Claude Code are read-only and only run plain reads (SELECT, WITH ... SELECT, EXPLAIN, SHOW, DESCRIBE).`;
    }
  }
  if (!isReadOnlyScript(sql, kind)) {
    return 'Only read-only statements can run: connections shared with Claude Code are read-only.';
  }
  return null;
}
