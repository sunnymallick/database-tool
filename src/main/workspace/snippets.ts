/**
 * snippets.json: saved SQL snippets, listed by name.
 */
import { randomUUID } from 'node:crypto';
import type { Snippet } from '@shared/types';
import { AppError } from '../errors';
import { dataFile } from '../paths';
import { readJsonFile, writeJsonAtomic } from './json-file';

function isSnippet(x: unknown): x is Snippet {
  const s = x as Snippet;
  return !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.sql === 'string';
}

export class SnippetStore {
  constructor(private readonly file: string = dataFile('snippets.json')) {}

  private read(): Snippet[] {
    const raw = readJsonFile<unknown>(this.file, []);
    return Array.isArray(raw) ? raw.filter(isSnippet) : [];
  }

  list(): Snippet[] {
    return this.read().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** Insert or replace by id (a missing id creates a new snippet). */
  save(input: Snippet): Snippet {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) throw new AppError('A snippet needs a name', 'BAD_REQUEST');
    if (typeof input.sql !== 'string') throw new AppError('A snippet needs SQL text', 'BAD_REQUEST');
    const snippet: Snippet = { id: input.id || randomUUID(), name, sql: input.sql, updatedAt: new Date().toISOString() };
    if (typeof input.description === 'string' && input.description.trim()) snippet.description = input.description.trim();
    const all = this.read().filter((s) => s.id !== snippet.id);
    all.push(snippet);
    writeJsonAtomic(this.file, all);
    return snippet;
  }

  delete(id: string): void {
    const all = this.read();
    const kept = all.filter((s) => s.id !== id);
    if (kept.length !== all.length) writeJsonAtomic(this.file, kept);
  }
}
