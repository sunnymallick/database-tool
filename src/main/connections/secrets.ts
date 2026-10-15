/**
 * Password storage.
 *
 * macOS: the login Keychain through the `security` CLI (generic passwords,
 * service `database-tool` or $DATABASE_TOOL_KEYCHAIN_SERVICE, account = the
 * profile id). Elsewhere, or when `security` is missing, a 0600 secrets.json
 * in the data directory. On macOS a Keychain write failure (locked or denied
 * keychain) falls back to the file so a save never silently loses a password.
 *
 * Known limitation: `security add-generic-password -w <pw>` passes the
 * password as a process argument, briefly visible to same-user `ps`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AppError } from '../errors';
import { dataFile } from '../paths';
import { readJsonFile, writeJsonAtomic } from '../workspace/json-file';

export interface SecretStore {
  readonly kind: 'keychain' | 'file' | 'keychain+file';
  get(profileId: string): Promise<string | null>;
  set(profileId: string, password: string): Promise<void>;
  delete(profileId: string): Promise<void>;
  /** Whether a password exists, without reading it (no Keychain prompt). */
  has(profileId: string): Promise<boolean>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell. Injected in tests so nothing touches the real Keychain. */
export type CommandRunner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<CommandResult>;

export const execRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 15_000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : -1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });

export const SECURITY_BIN = '/usr/bin/security';
/** `security` exit status for errSecItemNotFound. */
export const SECURITY_NOT_FOUND = 44;

export function keychainService(): string {
  return process.env.DATABASE_TOOL_KEYCHAIN_SERVICE?.trim() || 'database-tool';
}

/** `security -w` prints the secret followed by a newline. */
function stripNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

export class KeychainSecretStore implements SecretStore {
  readonly kind = 'keychain' as const;

  constructor(
    private readonly service: string = keychainService(),
    private readonly run: CommandRunner = execRunner
  ) {}

  async get(profileId: string): Promise<string | null> {
    const r = await this.run(SECURITY_BIN, ['find-generic-password', '-s', this.service, '-a', profileId, '-w']);
    if (r.code === 0) return stripNewline(r.stdout);
    if (r.code === SECURITY_NOT_FOUND) return null;
    throw new AppError(`Could not read the password from the Keychain: ${r.stderr.trim() || `exit ${r.code}`}`, 'KEYCHAIN');
  }

  async set(profileId: string, password: string): Promise<void> {
    // -U updates an existing item instead of failing with a duplicate.
    const r = await this.run(SECURITY_BIN, ['add-generic-password', '-U', '-s', this.service, '-a', profileId, '-w', password]);
    if (r.code !== 0) throw new AppError(`Could not save the password to the Keychain: ${r.stderr.trim() || `exit ${r.code}`}`, 'KEYCHAIN');
  }

  async delete(profileId: string): Promise<void> {
    const r = await this.run(SECURITY_BIN, ['delete-generic-password', '-s', this.service, '-a', profileId]);
    if (r.code !== 0 && r.code !== SECURITY_NOT_FOUND) {
      throw new AppError(`Could not delete the password from the Keychain: ${r.stderr.trim() || `exit ${r.code}`}`, 'KEYCHAIN');
    }
  }

  async has(profileId: string): Promise<boolean> {
    // Without -w only attributes are read, which never prompts.
    const r = await this.run(SECURITY_BIN, ['find-generic-password', '-s', this.service, '-a', profileId]);
    return r.code === 0;
  }
}

interface SecretsFile {
  version: 1;
  secrets: Record<string, string>;
}

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;

  constructor(private readonly file: string = dataFile('secrets.json')) {}

  private read(): Record<string, string> {
    const raw = readJsonFile<Partial<SecretsFile>>(this.file, {});
    return raw && typeof raw.secrets === 'object' && raw.secrets ? { ...raw.secrets } : {};
  }

  private write(secrets: Record<string, string>): void {
    writeJsonAtomic(this.file, { version: 1, secrets } satisfies SecretsFile, 0o600);
  }

  async get(profileId: string): Promise<string | null> {
    return this.read()[profileId] ?? null;
  }

  async set(profileId: string, password: string): Promise<void> {
    const all = this.read();
    all[profileId] = password;
    this.write(all);
  }

  async delete(profileId: string): Promise<void> {
    const all = this.read();
    if (!(profileId in all)) return;
    delete all[profileId];
    this.write(all);
  }

  async has(profileId: string): Promise<boolean> {
    return profileId in this.read();
  }
}

/** Keychain first; the file catches writes the Keychain refuses and keeps reads working for them. */
export class FallbackSecretStore implements SecretStore {
  readonly kind = 'keychain+file' as const;

  constructor(
    private readonly primary: SecretStore,
    private readonly fallback: SecretStore
  ) {}

  async get(profileId: string): Promise<string | null> {
    try {
      const v = await this.primary.get(profileId);
      if (v !== null) return v;
    } catch (err) {
      const fromFile = await this.fallback.get(profileId);
      if (fromFile !== null) return fromFile;
      throw err;
    }
    return this.fallback.get(profileId);
  }

  async set(profileId: string, password: string): Promise<void> {
    try {
      await this.primary.set(profileId, password);
      await this.fallback.delete(profileId);
    } catch (err) {
      console.error('[secrets] Keychain write failed; storing the password in secrets.json instead:', err);
      await this.fallback.set(profileId, password);
    }
  }

  async delete(profileId: string): Promise<void> {
    await this.fallback.delete(profileId);
    await this.primary.delete(profileId);
  }

  async has(profileId: string): Promise<boolean> {
    return (await this.fallback.has(profileId)) || (await this.primary.has(profileId).catch(() => false));
  }
}

export interface SecretStoreOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  /** secrets.json location (defaults to the data directory). */
  file?: string;
}

/**
 * The store for this machine. Set DATABASE_TOOL_SECRETS=file to force the
 * file backend (tests and smoke runs use it to stay out of the Keychain).
 */
export function createSecretStore(opts: SecretStoreOptions = {}): SecretStore {
  const file = new FileSecretStore(opts.file ?? dataFile('secrets.json'));
  const platform = opts.platform ?? process.platform;
  const keychainUsable = platform === 'darwin' && (opts.runner !== undefined || existsSync(SECURITY_BIN));
  if (process.env.DATABASE_TOOL_SECRETS === 'file' || !keychainUsable) return file;
  return new FallbackSecretStore(new KeychainSecretStore(keychainService(), opts.runner ?? execRunner), file);
}
