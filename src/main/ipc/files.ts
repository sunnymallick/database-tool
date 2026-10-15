import { app, BrowserWindow, dialog, shell } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError } from '../errors';
import { LastFolders, safeFileName, writeNewFile } from '../file-utils';
import { dataDir, dataFile } from '../paths';
import type { OpenFileRequest } from '@shared/types';
import type { Router } from './types';

/**
 * Paths the renderer may read or write: anything the user picked in a native
 * dialog. Persisted so files reopened from a restored session can be saved.
 */
const ALLOWLIST_FILE = 'allowed-files.json';
const MAX_ALLOWED = 500;
let allowed: string[] | null = null;

function allowedPaths(): string[] {
  if (allowed) return allowed;
  try {
    const parsed: unknown = JSON.parse(readFileSync(dataFile(ALLOWLIST_FILE), 'utf8'));
    allowed = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    allowed = [];
  }
  return allowed;
}

export function allowPath(p: string): void {
  const abs = resolve(p);
  const list = allowedPaths().filter((x) => x !== abs);
  list.push(abs);
  allowed = list.slice(-MAX_ALLOWED);
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(dataFile(ALLOWLIST_FILE), JSON.stringify(allowed, null, 2));
  } catch (err) {
    console.error('[files] could not persist allowlist', err);
  }
}

function assertAllowed(p: string): string {
  const abs = resolve(p);
  if (!allowedPaths().includes(abs)) throw new AppError('File access is limited to files chosen in a dialog', 'FORBIDDEN');
  return abs;
}

/** Folders picked with dialog.openDirectory this session; new files may be created directly inside them. */
const allowedDirs = new Set<string>();

const lastDir = new LastFolders();

export function registerFileHandlers(r: Router): void {
  r.handle('app.info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    chrome: process.versions.chrome ?? '',
    platform: process.platform,
    dataDir: dataDir()
  }));

  const showOpen = async (opts: Electron.OpenDialogOptions): Promise<string[]> => {
    const win = BrowserWindow.getFocusedWindow();
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? [] : res.filePaths;
  };

  const pickFiles = async (req: OpenFileRequest, multiple: boolean): Promise<string[]> => {
    const picked = await showOpen({
      title: req.title,
      buttonLabel: req.buttonLabel,
      defaultPath: lastDir.startPath('open', req.defaultPath),
      filters: req.filters,
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile']
    });
    for (const p of picked) allowPath(p);
    if (picked[0]) lastDir.open = dirname(picked[0]);
    return picked;
  };

  r.handle('dialog.openFile', async (req) => (await pickFiles(req, false))[0] ?? null);
  r.handle('dialog.openFiles', (req) => pickFiles(req, true));

  r.handle('dialog.saveFile', async (req) => {
    const win = BrowserWindow.getFocusedWindow();
    const opts: Electron.SaveDialogOptions = {
      title: req.title,
      buttonLabel: req.buttonLabel,
      defaultPath: lastDir.startPath('save', req.defaultPath),
      filters: req.filters,
      properties: ['createDirectory', 'showOverwriteConfirmation']
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    allowPath(res.filePath);
    lastDir.save = dirname(res.filePath);
    return res.filePath;
  });

  r.handle('dialog.openDirectory', async (req) => {
    const [dir] = await showOpen({
      title: req.title,
      buttonLabel: req.buttonLabel,
      defaultPath: lastDir.startPath('save', req.defaultPath),
      properties: ['openDirectory', 'createDirectory']
    });
    if (!dir) return null;
    const abs = resolve(dir);
    allowedDirs.add(abs);
    lastDir.save = abs;
    return abs;
  });

  r.handle('files.read', async ({ path }) => {
    const abs = assertAllowed(path);
    return { path: abs, content: await readFile(abs, 'utf8') };
  });

  r.handle('files.write', async ({ path, content }) => {
    const abs = assertAllowed(path);
    await writeFile(abs, content, 'utf8');
  });

  r.handle('files.writeBytes', async ({ path, data }) => {
    const abs = assertAllowed(path);
    await writeFile(abs, data);
  });

  r.handle('files.writeToDirectory', async ({ dir, files }) => {
    const absDir = resolve(dir);
    if (!allowedDirs.has(absDir)) throw new AppError('Choose the folder in a dialog first', 'FORBIDDEN');
    const paths: string[] = [];
    for (const f of files) {
      const path = await writeNewFile(absDir, safeFileName(f.name), f.content);
      allowPath(path);
      paths.push(path);
    }
    return { paths };
  });

  r.handle('shell.showItemInFolder', ({ path }) => {
    shell.showItemInFolder(assertAllowed(path));
  });

  r.handle('shell.openExternal', async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) throw new AppError('Only http(s) links can be opened', 'FORBIDDEN');
    await shell.openExternal(url);
  });
}
