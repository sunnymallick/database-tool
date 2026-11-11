/**
 * Append-only log of what Claude Code and the CLI did, one JSON object per
 * line in <dataDir>/claude-code-audit.jsonl. Kept apart from history.json so
 * this process never races the app's writes to that file. Best effort: a
 * logging failure never fails the call.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataFile } from '../paths';

export const AUDIT_FILE = 'claude-code-audit.jsonl';

export interface AuditEntry {
  source: 'mcp' | 'cli';
  action: string;
  connection?: string;
  database?: string;
  sql?: string;
  /** `schema.table` for describe/ddl calls. */
  object?: string;
  durationMs?: number;
  rowCount?: number;
  error?: string;
}

export function appendAudit(entry: AuditEntry, file: string = dataFile(AUDIT_FILE)): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch (err) {
    console.error('[audit] could not write entry:', err);
  }
}
