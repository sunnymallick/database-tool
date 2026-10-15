/**
 * history.jsonl: one JSON object per line, appended per run. Listing reads
 * newest first with optional search and profile filters. The file is trimmed
 * back to `maxEntries` once it grows past that plus some slack, so appends
 * stay O(1) most of the time.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryEntry, HistoryQuery } from '@shared/types';
import { dataFile } from '../paths';
import { writeFileAtomic } from './json-file';

export const HISTORY_MAX_ENTRIES = 5000;
/** Very large scripts are stored truncated so the file stays small. */
const MAX_SQL_CHARS = 100_000;
const DEFAULT_LIST_LIMIT = 200;

export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'ts'>;

function parseLine(line: string): HistoryEntry | null {
  if (!line.trim()) return null;
  try {
    const e = JSON.parse(line) as HistoryEntry;
    return typeof e.id === 'string' && typeof e.sql === 'string' && typeof e.ts === 'string' ? e : null;
  } catch {
    return null;
  }
}

export class HistoryStore {
  private lineCount: number | null = null;

  constructor(
    private readonly file: string = dataFile('history.jsonl'),
    private readonly maxEntries = HISTORY_MAX_ENTRIES
  ) {}

  private readAll(): HistoryEntry[] {
    if (!existsSync(this.file)) return [];
    const out: HistoryEntry[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      const e = parseLine(line);
      if (e) out.push(e);
    }
    return out;
  }

  append(entry: NewHistoryEntry): HistoryEntry {
    const full: HistoryEntry = {
      ...entry,
      sql: entry.sql.length > MAX_SQL_CHARS ? entry.sql.slice(0, MAX_SQL_CHARS) : entry.sql,
      id: randomUUID(),
      ts: new Date().toISOString()
    };
    mkdirSync(dirname(this.file), { recursive: true });
    if (this.lineCount === null) this.lineCount = this.readAll().length;
    appendFileSync(this.file, `${JSON.stringify(full)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.lineCount++;
    if (this.lineCount > this.maxEntries + Math.max(50, Math.floor(this.maxEntries / 10))) this.trim();
    return full;
  }

  private trim(): void {
    const kept = this.readAll().slice(-this.maxEntries);
    writeFileAtomic(this.file, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 0o600);
    this.lineCount = kept.length;
  }

  list(query: HistoryQuery = {}): HistoryEntry[] {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, this.maxEntries));
    const needle = query.search?.trim().toLowerCase();
    const out: HistoryEntry[] = [];
    const all = this.readAll();
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const e = all[i];
      if (query.profileId && e.profileId !== query.profileId) continue;
      if (needle && !e.sql.toLowerCase().includes(needle) && !e.connectionName.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  }

  clear(): void {
    writeFileAtomic(this.file, '', 0o600);
    this.lineCount = 0;
  }
}
