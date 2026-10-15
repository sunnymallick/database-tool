/**
 * Pure file helpers for the dialog/file IPC handlers (kept free of Electron
 * so they can be unit-tested).
 */
import { open } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';

/**
 * Remembers the last folders used this session so the next dialog opens
 * there. Memory only: a restart starts from the OS default again. Saves and
 * opens are tracked separately so opening a file doesn't move the export location.
 */
export class LastFolders {
  save: string | null = null;
  open: string | null = null;

  /** Where a dialog should start: a bare file name goes in the remembered folder; absolute paths are kept. */
  startPath(kind: 'save' | 'open', requested?: string): string | undefined {
    const dir = kind === 'save' ? this.save : (this.open ?? this.save);
    if (requested && isAbsolute(requested)) return requested;
    if (!dir) return requested || undefined;
    return requested ? join(dir, requested) : dir;
  }
}

/** Reduce a requested name to a safe bare file name (no folders, no reserved characters). */
export function safeFileName(name: string): string {
  const cleaned = basename(name.replace(/[\\/]/g, '_'))
    .replace(/[\u0000-\u001f:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'export';
}

/** Create `name` inside `dir` without overwriting anything: "name (2).ext", "name (3).ext", ... */
export async function writeNewFile(dir: string, name: string, content: string | Uint8Array): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const path = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    let handle;
    try {
      handle = await open(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return path;
  }
  throw new Error(`Too many files named like ${name} in ${dir}`);
}
