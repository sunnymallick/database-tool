/**
 * Small synchronous JSON file helpers for the data directory. Files are tiny
 * and writes are rare, so sync IO keeps ordering trivial (no interleaved
 * writers) without noticeable cost.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Parse a JSON file, or return `fallback` when it is missing. A file that
 * cannot be parsed is moved aside (never silently overwritten) so the user's
 * data can be recovered by hand.
 */
export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const aside = `${path}.corrupt-${Date.now()}`;
    console.error(`[workspace] ${path} is not valid JSON; moved to ${aside}:`, err);
    renameSync(path, aside);
    return fallback;
  }
}

/** Write via a temp file and rename, so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode });
    renameSync(tmp, path);
    // rename keeps the temp file's mode, but an existing target created earlier may have looser bits.
    chmodSync(path, mode);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}

export function writeJsonAtomic(path: string, data: unknown, mode = 0o644): void {
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, mode);
}
