/**
 * The data services behind the db-tool MCP server and CLI: saved profiles
 * (re-read whenever connections.json changes, so turning access off in the
 * app takes effect on the next call), Keychain passwords, and a Registry that
 * only ever sees exposed, read-only profiles.
 *
 * Must not import 'electron': this runs under plain Node or ELECTRON_RUN_AS_NODE.
 */
import { readFileSync, statSync } from 'node:fs';
import type { ConnRef, ConnectionProfile } from '@shared/types';
import { Registry, type ConnectFn } from '../connections/registry';
import { createSecretStore, type SecretStore } from '../connections/secrets';
import { normalizeProfile } from '../connections/store';
import { connectDriver } from '../db';
import type { Driver } from '../db/driver';
import { dataFile } from '../paths';
import { connRefFor, exposedProfiles, resolveProfile, type ConnectionScope } from './access';

export interface ExternalDeps {
  scope?: ConnectionScope;
  profilesFile?: string;
  secrets?: SecretStore;
  connect?: ConnectFn;
}

/** A resolved target: the read-only profile and the ConnRef to acquire. */
export interface Target {
  profile: ConnectionProfile;
  ref: ConnRef;
}

/**
 * connections.json, reloaded when its mtime or size changes. Read-only: unlike
 * the app's ProfileStore it never moves a corrupt file aside, and any read or
 * parse failure yields no profiles (fail closed) and is retried next call.
 */
export class LiveProfiles {
  private stamp = '';
  private profiles: ConnectionProfile[] = [];

  constructor(private readonly file: string = dataFile('connections.json')) {}

  /** The current profiles, and whether they changed since the last call. */
  read(): { profiles: ConnectionProfile[]; changed: boolean } {
    let stamp: string;
    try {
      const st = statSync(this.file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = 'missing';
    }
    if (stamp === this.stamp) return { profiles: this.profiles, changed: false };
    const before = this.profiles;
    try {
      this.profiles = stamp === 'missing' ? [] : parseProfiles(readFileSync(this.file, 'utf8'));
      this.stamp = stamp;
    } catch (err) {
      console.error(`[db-tool] could not read ${this.file}; no connections are available until it is fixed:`, err);
      this.profiles = [];
      this.stamp = ''; // retry on the next call
    }
    return { profiles: this.profiles, changed: this.profiles !== before };
  }
}

function parseProfiles(text: string): ConnectionProfile[] {
  if (text.trim() === '') return [];
  const raw = JSON.parse(text) as { profiles?: unknown } | unknown[];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.profiles) ? raw.profiles : [];
  return list.filter((p): p is Partial<ConnectionProfile> => !!p && typeof p === 'object').map((p) => normalizeProfile(p));
}

export class ExternalServices {
  readonly registry: Registry;
  private readonly live: LiveProfiles;
  private readonly scope: ConnectionScope;
  private exposed: ConnectionProfile[] = [];
  private fingerprints = new Map<string, string>();

  constructor(deps: ExternalDeps = {}) {
    this.scope = deps.scope ?? [];
    this.live = new LiveProfiles(deps.profilesFile);
    const secrets = deps.secrets ?? createSecretStore();
    this.registry = new Registry({
      listProfiles: () => this.profiles(),
      getProfile: (id) => this.profiles().find((p) => p.id === id),
      getPassword: (id) => secrets.get(id),
      connect: deps.connect ?? connectDriver
    });
  }

  /** Exposed profiles (forced read-only), refreshed from disk when the file changed. */
  profiles(): ConnectionProfile[] {
    const { profiles, changed } = this.live.read();
    if (changed) {
      this.exposed = exposedProfiles(profiles, this.scope);
      this.dropStale();
    }
    return this.exposed;
  }

  /** Close connections whose profile was unshared, deleted, or re-pointed since they opened. */
  private dropStale(): void {
    const next = new Map(this.exposed.map((p) => [p.id, fingerprint(p)]));
    for (const [id, fp] of this.fingerprints) {
      if (next.get(id) !== fp) void this.registry.disconnectProfile(id);
    }
    this.fingerprints = next;
  }

  /** Resolve a connection name or id (and optional database) to a target, or throw a NOT_EXPOSED error. */
  target(connection: string, database?: string): Target {
    const profile = resolveProfile(this.profiles(), connection);
    return { profile, ref: connRefFor(profile, database) };
  }

  acquire(target: Target): Promise<Driver> {
    return this.registry.acquire(target.ref);
  }

  close(): Promise<void> {
    return this.registry.closeAll();
  }
}

function fingerprint(p: ConnectionProfile): string {
  return JSON.stringify([p.kind, p.host, p.port, p.database, p.username, p.filePath, p.ssl, p.trustServerCertificate, p.options, p.extraDatabases]);
}
