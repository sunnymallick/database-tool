import { describe, expect, it } from 'vitest';
import type { DbMeta } from '@shared/types';
import { writePolicy } from '../../src/main/ai/approvals';
import { buildDynamicPrompt, staticPrompt, summarizeSchema } from '../../src/main/ai/prompt';
import { makeProfile } from './fakes';

function meta(tables: number, cols = 4): DbMeta {
  return {
    defaultSchema: 'public',
    schemas: ['public'],
    tables: Array.from({ length: tables }, (_, i) => ({
      schema: 'public',
      name: `table_${i}`,
      kind: 'table' as const,
      columns: Array.from({ length: cols }, (_, c) => ({ name: `col_${c}`, type: 'text' }))
    }))
  };
}

describe('schema summary', () => {
  it('lists tables with columns', () => {
    expect(summarizeSchema(meta(2, 2))).toBe('- table_0(col_0 text, col_1 text)\n- table_1(col_0 text, col_1 text)');
  });

  it('stays within the cap and names the tables it could not fit', () => {
    const s = summarizeSchema(meta(500, 20), 4_000);
    expect(s.length).toBeLessThan(4_000 + 2_200);
    expect(s).toMatch(/more tables without columns listed: table_\d+/);
    expect(s).toMatch(/use describe_table\)$/);
  });

  it('qualifies tables outside the default schema', () => {
    const m: DbMeta = {
      defaultSchema: 'public',
      schemas: ['public', 'audit'],
      tables: [
        { schema: 'public', name: 'a', kind: 'table', columns: [] },
        { schema: 'audit', name: 'log', kind: 'view', columns: [{ name: 'id', type: 'int' }] }
      ]
    };
    expect(summarizeSchema(m)).toBe('- public.a()\n- audit.log [view](id int)');
  });
});

describe('dynamic prompt', () => {
  it('describes a production read-only connection', () => {
    const profile = makeProfile({ name: 'Prod', kind: 'mssql', production: true, readOnly: true });
    const p = buildDynamicPrompt({
      profile,
      conn: { profileId: profile.id, database: 'Sales' },
      database: 'Sales',
      meta: meta(1, 1),
      write: writePolicy(profile, true),
      editor: { tabId: 't', title: 'Query 1', sql: 'SELECT TOP 5 * FROM x', selection: null, conn: null }
    });
    expect(p).toContain('Connection: "Prod" (SQL Server)');
    expect(p).toContain('Database: Sales');
    expect(p).toContain('Flags: READ-ONLY, PRODUCTION');
    expect(p).toContain('Writes: refused');
    expect(p).toContain('T-SQL');
    expect(p).toContain('SELECT TOP 5 * FROM x');
  });

  it('explains the no-database case', () => {
    const p = buildDynamicPrompt({ profile: null, conn: null, database: null, meta: null, write: writePolicy(null, false), editor: null });
    expect(p).toMatch(/No database is selected/);
    expect(p).toMatch(/did not share an editor/);
  });

  it('keeps the static prompt free of per-session details', () => {
    expect(staticPrompt()).not.toMatch(/Connection:/);
    expect(staticPrompt()).toMatch(/propose_sql/);
  });
});
