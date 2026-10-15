/**
 * OWNER: workbench (UI) slice. localStorage persistence for the mock backend,
 * with an in-memory fallback when storage is unavailable (tests, private mode).
 */

const PREFIX = 'dbt.mock.';
const memory = new Map<string, string>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadJson<T>(key: string, fallback: () => T): T {
  const raw = storage()?.getItem(PREFIX + key) ?? memory.get(PREFIX + key) ?? null;
  if (raw !== null) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt entry: fall through and reseed.
    }
  }
  const value = fallback();
  saveJson(key, value);
  return value;
}

export function saveJson(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  const s = storage();
  if (s) {
    try {
      s.setItem(PREFIX + key, raw);
      return;
    } catch {
      // Quota exceeded: keep it in memory for this session.
    }
  }
  memory.set(PREFIX + key, raw);
}

export function removeKey(key: string): void {
  storage()?.removeItem(PREFIX + key);
  memory.delete(PREFIX + key);
}

/** Read without seeding; null when absent. */
export function peekJson<T>(key: string): T | null {
  const raw = storage()?.getItem(PREFIX + key) ?? memory.get(PREFIX + key) ?? null;
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function newMockId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
