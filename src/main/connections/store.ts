/**
 * connections.json: saved connection profiles (never passwords). Profiles are
 * normalized on read and validated on save; `hasPassword` is not stored but
 * derived by the caller from the secret store.
 */
import { randomUUID } from 'node:crypto';
import { DB_KINDS, dbKindInfo, type ConnectionProfile, type DbKind } from '@shared/types';
import { AppError } from '../errors';
import { dataFile } from '../paths';
import { readJsonFile, writeJsonAtomic } from '../workspace/json-file';

interface ProfilesFile {
  version: 1;
  profiles: ConnectionProfile[];
}

const KINDS = new Set<string>(DB_KINDS.map((k) => k.kind));
const COLOR = /^#[0-9a-f]{6}$/i;

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v)) if (val !== undefined && val !== null && String(val).trim() !== '') out[k] = String(val);
  return out;
}

/**
 * Fill defaults and coerce types so the rest of the app can trust the shape.
 * Never throws: used on profiles read from disk.
 */
export function normalizeProfile(raw: Partial<ConnectionProfile>, now = new Date().toISOString()): ConnectionProfile {
  const kind = (KINDS.has(asString(raw.kind)) ? raw.kind : 'postgres') as DbKind;
  const info = dbKindInfo(kind);
  const port = Number(raw.port);
  const database = asString(raw.database).trim();
  const extra = Array.isArray(raw.extraDatabases) ? raw.extraDatabases.filter((d): d is string => typeof d === 'string').map((d) => d.trim()) : [];
  return {
    id: asString(raw.id) || randomUUID(),
    name: asString(raw.name).trim(),
    kind,
    host: info.fileBased ? '' : asString(raw.host).trim(),
    port: info.fileBased ? 0 : Number.isInteger(port) && port > 0 && port <= 65535 ? port : info.defaultPort,
    database: info.fileBased ? '' : database,
    username: info.fileBased ? '' : asString(raw.username),
    filePath: info.fileBased ? asString(raw.filePath).trim() : '',
    ssl: raw.ssl === true,
    trustServerCertificate: raw.trustServerCertificate === true,
    options: stringRecord(raw.options),
    extraDatabases: [...new Set(extra.filter((d) => d !== '' && d !== database))],
    color: typeof raw.color === 'string' && COLOR.test(raw.color) ? raw.color.toLowerCase() : null,
    group: typeof raw.group === 'string' && raw.group.trim() ? raw.group.trim() : null,
    production: raw.production === true,
    readOnly: raw.readOnly === true,
    hasPassword: false,
    createdAt: asString(raw.createdAt) || now,
    updatedAt: asString(raw.updatedAt) || now
  };
}

/** Reject profiles the app cannot connect with; messages are shown in the connection dialog. */
export function validateProfile(raw: Partial<ConnectionProfile>): void {
  if (!raw || typeof raw !== 'object') throw new AppError('Connection profile is missing', 'BAD_PROFILE');
  if (!KINDS.has(asString(raw.kind))) throw new AppError(`Unknown database kind "${String(raw.kind)}"`, 'BAD_PROFILE');
  if (!asString(raw.name).trim()) throw new AppError('Give the connection a name', 'BAD_PROFILE');
  const info = dbKindInfo(raw.kind as DbKind);
  if (info.fileBased) {
    if (!asString(raw.filePath).trim()) throw new AppError('Choose a SQLite database file', 'BAD_PROFILE');
  } else {
    if (!asString(raw.host).trim()) throw new AppError('Enter a host name', 'BAD_PROFILE');
    const port = Number(raw.port);
    if (raw.port !== undefined && raw.port !== 0 && !(Number.isInteger(port) && port > 0 && port <= 65535)) {
      throw new AppError('Port must be a whole number between 1 and 65535', 'BAD_PROFILE');
    }
  }
  if (raw.color !== null && raw.color !== undefined && !(typeof raw.color === 'string' && COLOR.test(raw.color))) {
    throw new AppError('Color must look like #rrggbb', 'BAD_PROFILE');
  }
  const timeout = raw.options?.connectTimeoutSec;
  if (timeout !== undefined && timeout !== '' && !(Number(timeout) > 0 && Number(timeout) <= 600)) {
    throw new AppError('Connect timeout must be between 1 and 600 seconds', 'BAD_PROFILE');
  }
}

/** Fields that change what a live connection talks to; editing them drops open connections. */
export function connectionFieldsChanged(a: ConnectionProfile, b: ConnectionProfile): boolean {
  const pick = (p: ConnectionProfile) =>
    JSON.stringify([p.kind, p.host, p.port, p.database, p.username, p.filePath, p.ssl, p.trustServerCertificate, p.options, p.readOnly]);
  return pick(a) !== pick(b);
}

export class ProfileStore {
  private cache: ConnectionProfile[] | null = null;

  constructor(private readonly file: string = dataFile('connections.json')) {}

  private load(): ConnectionProfile[] {
    if (!this.cache) {
      const raw = readJsonFile<Partial<ProfilesFile> | ConnectionProfile[]>(this.file, { version: 1, profiles: [] });
      const list = Array.isArray(raw) ? raw : Array.isArray(raw.profiles) ? raw.profiles : [];
      this.cache = list.filter((p) => p && typeof p === 'object').map((p) => normalizeProfile(p));
    }
    return this.cache;
  }

  private persist(profiles: ConnectionProfile[]): void {
    const stored = profiles.map((p) => ({ ...p, hasPassword: undefined }));
    writeJsonAtomic(this.file, { version: 1, profiles: stored });
    this.cache = profiles;
  }

  list(): ConnectionProfile[] {
    return this.load().map((p) => ({ ...p, options: { ...p.options }, extraDatabases: [...p.extraDatabases] }));
  }

  get(id: string): ConnectionProfile | undefined {
    const p = this.load().find((x) => x.id === id);
    return p ? { ...p, options: { ...p.options }, extraDatabases: [...p.extraDatabases] } : undefined;
  }

  /** Validate, normalize, stamp, and save. Returns the stored profile and the one it replaced. */
  upsert(input: ConnectionProfile): { saved: ConnectionProfile; previous?: ConnectionProfile } {
    validateProfile(input);
    const now = new Date().toISOString();
    const all = this.load();
    const index = input.id ? all.findIndex((p) => p.id === input.id) : -1;
    const previous = index >= 0 ? all[index] : undefined;
    const saved = normalizeProfile({ ...input, id: input.id || randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now }, now);
    const next = [...all];
    if (index >= 0) next[index] = saved;
    else next.push(saved);
    this.persist(next);
    return { saved: { ...saved }, previous };
  }

  /** Append several new profiles at once (import). */
  addMany(profiles: ConnectionProfile[]): void {
    if (profiles.length === 0) return;
    this.persist([...this.load(), ...profiles]);
  }

  remove(id: string): ConnectionProfile | undefined {
    const all = this.load();
    const found = all.find((p) => p.id === id);
    if (found) this.persist(all.filter((p) => p.id !== id));
    return found;
  }
}
