/**
 * session.json: renderer-owned workspace state (open tabs, layout). Opaque
 * to main; only checked to be JSON and of reasonable size.
 */
import { AppError } from '../errors';
import { dataFile } from '../paths';
import { readJsonFile, writeFileAtomic } from './json-file';

const MAX_SESSION_BYTES = 20 * 1024 * 1024;

export class SessionStore {
  constructor(private readonly file: string = dataFile('session.json')) {}

  load(): unknown {
    return readJsonFile<unknown>(this.file, null);
  }

  save(data: unknown): void {
    const text = JSON.stringify(data ?? null);
    if (text === undefined) throw new AppError('Session state must be JSON-serializable', 'BAD_REQUEST');
    if (text.length > MAX_SESSION_BYTES) throw new AppError('Session state is too large to save', 'TOO_LARGE');
    writeFileAtomic(this.file, text);
  }
}
