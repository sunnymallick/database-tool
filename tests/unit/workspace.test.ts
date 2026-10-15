import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { HistoryStore } from '../../src/main/workspace/history';
import { readJsonFile, writeJsonAtomic } from '../../src/main/workspace/json-file';
import { SessionStore } from '../../src/main/workspace/session';
import { SettingsStore, normalizeSettings } from '../../src/main/workspace/settings';
import { SnippetStore } from '../../src/main/workspace/snippets';
import { tempDir } from '../integration/support';

const tmp = tempDir('workspace');
afterAll(() => tmp.cleanup());

describe('settings', () => {
  it('starts from defaults and merges valid stored values only', () => {
    expect(new SettingsStore(join(tmp.dir, 'none.json')).get()).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ theme: 'light', rowCap: 'lots', pageSize: 50, bogus: 1, editorWordWrap: 'yes' })).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', pageSize: 50 });
  });

  it('validates, clamps, persists, and notifies on update', () => {
    const file = join(tmp.dir, 'settings.json');
    const seen: AppSettings[] = [];
    const store = new SettingsStore(file, (s) => seen.push(s));
    const next = store.update({ rowCap: 5, editorFontSize: 100, pageSize: 250.4, theme: 'system', aiModel: '  claude-x  ' });
    expect(next).toMatchObject({ rowCap: 10, editorFontSize: 32, pageSize: 250, theme: 'system', aiModel: 'claude-x' });
    expect(seen).toEqual([next]);
    expect(JSON.parse(readFileSync(file, 'utf8')).rowCap).toBe(10);
    expect(new SettingsStore(file).get().pageSize).toBe(250);
    expect(store.update({ rowCap: 5_000_000 }).rowCap).toBe(1_000_000);

    expect(() => store.update({ theme: 'blue' as never })).toThrow(/theme/);
    expect(() => store.update({ rowCap: Number.NaN })).toThrow(/number/);
    expect(() => store.update({ editorLineNumbers: 'no' as never })).toThrow(/true or false/);
    expect(() => store.update({ aiModel: '' })).toThrow(/cannot be empty/);
    expect(() => store.update({ nope: 1 } as never)).toThrow(/Unknown setting/);
    // A rejected update changes nothing.
    expect(store.get().theme).toBe('system');
    expect(seen).toHaveLength(2);
  });
});

describe('history', () => {
  const entry = (sql: string, profileId = 'p1', connectionName = 'Local') => ({ profileId, connectionName, sql, durationMs: 1, rowCount: 1 });

  it('appends and lists newest first with search and profile filters', () => {
    const h = new HistoryStore(join(tmp.dir, 'history.jsonl'));
    h.append(entry('SELECT 1'));
    h.append(entry('select * from Orders', 'p2', 'Prod'));
    const last = h.append(entry('UPDATE t SET x = 1'));
    expect(last.id).toMatch(/[0-9a-f-]{36}/);
    expect(h.list().map((e) => e.sql)).toEqual(['UPDATE t SET x = 1', 'select * from Orders', 'SELECT 1']);
    expect(h.list({ search: 'ORDERS' }).map((e) => e.sql)).toEqual(['select * from Orders']);
    expect(h.list({ search: 'prod' })).toHaveLength(1);
    expect(h.list({ profileId: 'p1' })).toHaveLength(2);
    expect(h.list({ limit: 1 })).toHaveLength(1);
    h.clear();
    expect(h.list()).toEqual([]);
  });

  it('trims to the newest entries, skips corrupt lines, and truncates huge scripts', () => {
    const file = join(tmp.dir, 'history-trim.jsonl');
    writeFileSync(file, 'not json\n');
    const h = new HistoryStore(file, 10);
    for (let i = 1; i <= 70; i++) h.append(entry(`SELECT ${i}`));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThan(70);
    const all = h.list({ limit: 1000 });
    expect(all[0].sql).toBe('SELECT 70');
    expect(all.length).toBeLessThanOrEqual(10);
    const big = h.append(entry('x'.repeat(200_000)));
    expect(big.sql).toHaveLength(100_000);
  });
});

describe('snippets', () => {
  it('creates, updates, lists by name, and deletes', () => {
    const s = new SnippetStore(join(tmp.dir, 'snippets.json'));
    const b = s.save({ id: '', name: ' beta ', sql: 'SELECT 2', updatedAt: '' });
    const a = s.save({ id: '', name: 'Alpha', sql: 'SELECT 1', description: ' first ', updatedAt: '' });
    expect(b.id).not.toBe('');
    expect(a.description).toBe('first');
    expect(s.list().map((x) => x.name)).toEqual(['Alpha', 'beta']);
    s.save({ ...b, sql: 'SELECT 22' });
    expect(s.list().find((x) => x.id === b.id)?.sql).toBe('SELECT 22');
    expect(s.list()).toHaveLength(2);
    s.delete(a.id);
    expect(s.list().map((x) => x.name)).toEqual(['beta']);
    expect(() => s.save({ id: '', name: ' ', sql: 'x', updatedAt: '' })).toThrow(/name/);
  });
});

describe('session and JSON files', () => {
  it('round-trips opaque session state', () => {
    const s = new SessionStore(join(tmp.dir, 'session.json'));
    expect(s.load()).toBeNull();
    s.save({ tabs: [{ id: 1, sql: 'SELECT 1' }], active: 1 });
    expect(s.load()).toEqual({ tabs: [{ id: 1, sql: 'SELECT 1' }], active: 1 });
  });

  it('writes atomically and moves corrupt files aside', () => {
    const dir = tempDir('json');
    try {
      const file = join(dir.dir, 'data.json');
      writeJsonAtomic(file, { a: 1 });
      expect(readJsonFile(file, null)).toEqual({ a: 1 });
      expect(readdirSync(dir.dir)).toEqual(['data.json']);
      writeFileSync(file, '{oops');
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(readJsonFile(file, 'fallback')).toBe('fallback');
      err.mockRestore();
      expect(readdirSync(dir.dir).some((f) => f.startsWith('data.json.corrupt-'))).toBe(true);
    } finally {
      dir.cleanup();
    }
  });
});
