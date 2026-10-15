/**
 * Import connection profiles from dbTool (<dbtoolConfigDir()>/connections.json,
 * written by dbTool's `connections/mod.rs`). Pure planning: the caller saves
 * the returned profiles and passwords.
 *
 * Passwords: dbTool's plaintext `password_fallback` is used when present.
 * With `includePasswords`, dbTool's Keychain items (service "dbTool",
 * account = profile UUID) are read through `security`; macOS asks the user
 * to allow each read. The first denial or timeout stops further prompts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dbKindInfo, type ConnectionProfile, type DbKind } from '@shared/types';
import { AppError } from '../errors';
import { SECURITY_BIN, SECURITY_NOT_FOUND, type CommandRunner } from './secrets';
import { normalizeProfile } from './store';

/** The subset of dbTool's serialized ConnectionProfile we read. */
export interface DbtoolProfile {
  id?: string;
  name?: string;
  /** serde enum names: Postgres | MySql | MsSql | Sqlite */
  kind?: string;
  host?: string;
  port?: number;
  /** For Sqlite this is the database file path. */
  database?: string;
  username?: string;
  require_ssl?: boolean;
  password_fallback?: string;
  enabled_databases?: string[];
  color?: [number, number, number];
  ssh_enabled?: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  production?: boolean;
  read_only?: boolean;
}

export interface ImportWarning {
  name: string;
  message: string;
}

export interface PlannedImport {
  profile: ConnectionProfile;
  password: string | null;
}

export interface ImportPlan {
  sourcePath: string;
  items: PlannedImport[];
  skipped: { name: string; reason: string }[];
  warnings: ImportWarning[];
}

export const DBTOOL_KEYCHAIN_SERVICE = 'dbTool';
/** Long enough for the user to read and answer the macOS permission prompt. */
const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;

const KIND_MAP: Record<string, DbKind> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  mssql: 'mssql',
  sqlserver: 'mssql',
  sqlite: 'sqlite'
};

export function mapDbtoolKind(kind: unknown): DbKind | null {
  return typeof kind === 'string' ? (KIND_MAP[kind.toLowerCase()] ?? null) : null;
}

export function rgbToHex(color: unknown): string | null {
  if (!Array.isArray(color) || color.length !== 3 || !color.every((c) => typeof c === 'number' && Number.isFinite(c))) return null;
  return `#${color.map((c: number) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

/** Same server endpoint and login: the import would just create a copy. */
function endpointKey(p: Pick<ConnectionProfile, 'kind' | 'host' | 'port' | 'database' | 'username' | 'filePath'>): string {
  if (p.kind === 'sqlite') return `sqlite\u0000${p.filePath}`;
  return [p.kind, p.host.toLowerCase(), p.port, p.database, p.username].join('\u0000');
}

/** Convert one dbTool profile; returns a reason string when it cannot be imported. */
export function convertDbtoolProfile(src: DbtoolProfile, now = new Date().toISOString()): ConnectionProfile | string {
  const kind = mapDbtoolKind(src.kind);
  if (!kind) return `unsupported database kind "${String(src.kind)}"`;
  const name = (src.name ?? '').trim();
  if (!name) return 'profile has no name';
  const info = dbKindInfo(kind);
  const database = (src.database ?? '').trim();
  const port = Number(src.port);
  return normalizeProfile(
    {
      id: randomUUID(),
      name,
      kind,
      host: src.host ?? '',
      port: Number.isInteger(port) && port > 0 ? port : info.defaultPort,
      database: info.fileBased ? '' : database,
      filePath: info.fileBased ? database : '',
      username: src.username ?? '',
      ssl: src.require_ssl === true,
      // dbTool always trusted the server certificate for SQL Server.
      trustServerCertificate: kind === 'mssql',
      options: {},
      extraDatabases: Array.isArray(src.enabled_databases) ? src.enabled_databases : [],
      color: rgbToHex(src.color),
      group: null,
      production: src.production === true,
      readOnly: src.read_only === true,
      createdAt: now,
      updatedAt: now
    },
    now
  );
}

export interface PlanOptions {
  configDir: string;
  existing: ConnectionProfile[];
  includePasswords: boolean;
  /** Runs `security`; absent when Keychain import is impossible (not macOS). */
  runner?: CommandRunner;
}

function readSource(path: string): DbtoolProfile[] {
  if (!existsSync(path)) throw new AppError(`dbTool connections were not found at ${path}`, 'NOT_FOUND');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new AppError(`dbTool's connections.json could not be read: ${(err as Error).message}`, 'BAD_SOURCE');
  }
  if (!Array.isArray(parsed)) throw new AppError(`dbTool's connections.json is not a list of profiles`, 'BAD_SOURCE');
  return parsed.filter((p): p is DbtoolProfile => !!p && typeof p === 'object');
}

export async function planDbtoolImport(opts: PlanOptions): Promise<ImportPlan> {
  const sourcePath = join(opts.configDir, 'connections.json');
  const sources = readSource(sourcePath);
  const plan: ImportPlan = { sourcePath, items: [], skipped: [], warnings: [] };

  const names = new Set(opts.existing.map((p) => p.name.toLowerCase()));
  const endpoints = new Map(opts.existing.map((p) => [endpointKey(p), p.name]));
  let keychainBlocked = !opts.runner;
  let keychainMissed = 0;

  for (const src of sources) {
    const label = (src.name ?? '').trim() || '(unnamed)';
    const converted = convertDbtoolProfile(src);
    if (typeof converted === 'string') {
      plan.skipped.push({ name: label, reason: converted });
      continue;
    }
    if (names.has(converted.name.toLowerCase())) {
      plan.skipped.push({ name: label, reason: 'a connection with this name already exists' });
      continue;
    }
    const dupOf = endpoints.get(endpointKey(converted));
    if (dupOf !== undefined) {
      plan.skipped.push({ name: label, reason: `same server, database, and user as "${dupOf}"` });
      continue;
    }
    names.add(converted.name.toLowerCase());
    endpoints.set(endpointKey(converted), converted.name);

    if (src.ssh_enabled) {
      plan.warnings.push({
        name: converted.name,
        message: `Imported, but it used an SSH tunnel${src.ssh_host ? ` via ${src.ssh_host}` : ''}, which is not supported yet. Connect through a VPN or an ssh -L tunnel and point the profile at it.`
      });
    }

    let password: string | null = src.password_fallback ? src.password_fallback : null;
    if (password === null && opts.includePasswords && converted.kind !== 'sqlite' && src.id) {
      if (keychainBlocked) keychainMissed++;
      else {
        const r = await opts.runner!(SECURITY_BIN, ['find-generic-password', '-s', DBTOOL_KEYCHAIN_SERVICE, '-a', src.id, '-w'], { timeoutMs: KEYCHAIN_PROMPT_TIMEOUT_MS });
        if (r.code === 0) password = r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
        else if (r.code !== SECURITY_NOT_FOUND) {
          // Denied, cancelled, or timed out: do not keep prompting for every remaining profile.
          keychainBlocked = true;
          keychainMissed++;
        }
      }
    }
    plan.items.push({ profile: converted, password });
  }

  if (opts.includePasswords && !opts.runner) {
    plan.warnings.push({ name: 'Keychain', message: 'Passwords can only be copied from the macOS Keychain.' });
  } else if (keychainMissed > 0) {
    plan.warnings.push({
      name: 'Keychain',
      message: `Keychain access was denied or timed out; ${keychainMissed} password${keychainMissed === 1 ? ' was' : 's were'} not imported. Enter them in the connection dialog.`
    });
  }
  return plan;
}
