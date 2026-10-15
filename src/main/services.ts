/**
 * Services the data layer exposes to the rest of the main process. The data
 * layer implements them (src/main/ipc/data.ts -> createDataServices); the AI
 * slice consumes them.
 */
import type { AppSettings, ConnRef, ConnectionProfile, ConnectionStatus, HistoryEntry } from '@shared/types';
import type { Driver } from './db/driver';

export interface ConnectionRegistry {
  listProfiles(): ConnectionProfile[];
  getProfile(profileId: string): ConnectionProfile | undefined;
  status(ref: ConnRef): ConnectionStatus;
  /**
   * A connected driver for the ref, connecting first if needed. Profiles
   * marked read-only get a guarded driver whose `execute` rejects any
   * statement that is not read-only.
   */
  acquire(ref: ConnRef): Promise<Driver>;
}

export interface DataServices {
  registry: ConnectionRegistry;
  getSettings(): AppSettings;
  /** Append a query-history entry (best-effort, never throws). */
  recordHistory(entry: Omit<HistoryEntry, 'id' | 'ts'>): void;
  /** Close every open connection. Called once on app quit. */
  shutdown(): Promise<void>;
}
