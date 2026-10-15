import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LastFolders, safeFileName, writeNewFile } from '../../src/main/file-utils';

describe('LastFolders', () => {
  it('starts dialogs in the last folder only after something was chosen', () => {
    const f = new LastFolders();
    expect(f.startPath('save', 'Query 1.xlsx')).toBe('Query 1.xlsx');
    expect(f.startPath('save')).toBeUndefined();
    f.save = '/Users/me/exports';
    expect(f.startPath('save', 'Query 1.xlsx')).toBe('/Users/me/exports/Query 1.xlsx');
    expect(f.startPath('save')).toBe('/Users/me/exports');
  });

  it('keeps absolute paths (Save As of an opened file)', () => {
    const f = new LastFolders();
    f.save = '/Users/me/exports';
    expect(f.startPath('save', '/Users/me/queries/report.sql')).toBe('/Users/me/queries/report.sql');
  });

  it('tracks opens separately; opens fall back to the save folder', () => {
    const f = new LastFolders();
    f.save = '/exports';
    expect(f.startPath('open')).toBe('/exports');
    f.open = '/queries';
    expect(f.startPath('open')).toBe('/queries');
    expect(f.startPath('save', 'a.csv')).toBe('/exports/a.csv');
  });
});

describe('safeFileName', () => {
  it('strips folders and reserved characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('a/b\\c.csv')).toBe('a_b_c.csv');
    expect(safeFileName('Query: 1 * "x" <y>?.csv')).toBe('Query_ 1 _ _x_ _y__.csv');
    expect(safeFileName('...')).toBe('export');
    expect(safeFileName('')).toBe('export');
  });
});

describe('writeNewFile', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('never overwrites: adds (2), (3) suffixes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dt-write-'));
    writeFileSync(join(dir, 'Result 1.csv'), 'original');
    const a = await writeNewFile(dir, 'Result 1.csv', 'second');
    const b = await writeNewFile(dir, 'Result 1.csv', new TextEncoder().encode('third'));
    expect(a).toBe(join(dir, 'Result 1 (2).csv'));
    expect(b).toBe(join(dir, 'Result 1 (3).csv'));
    expect(readFileSync(join(dir, 'Result 1.csv'), 'utf8')).toBe('original');
    expect(readFileSync(b, 'utf8')).toBe('third');
    expect(readdirSync(dir).sort()).toEqual(['Result 1 (2).csv', 'Result 1 (3).csv', 'Result 1.csv']);
  });
});
