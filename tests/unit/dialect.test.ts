import { describe, expect, it } from 'vitest';
import type { RowChangeSet, Value } from '@shared/types';
import { buildChangeStatements, buildCountQuery, buildPageQuery, orderClause, rowMismatchError, whereClause } from '../../src/main/db/dialect';

const int = (v: string): Value => ({ t: 'int', v });
const txt = (v: string): Value => ({ t: 'text', v });

describe('paging SQL', () => {
  const spec = { schema: 's', table: 't', where: "status = 'paid' -- note", orderBy: [{ column: 'total', desc: true }], limit: 50, offset: 100 };

  it('postgres, sqlite: LIMIT/OFFSET with the filter fenced in parentheses', () => {
    expect(buildPageQuery('postgres', spec, ['id'])).toBe(`SELECT * FROM "s"."t"\nWHERE (\nstatus = 'paid' -- note\n)\nORDER BY "total" DESC\nLIMIT 50 OFFSET 100`);
    expect(buildPageQuery('sqlite', { ...spec, where: undefined, orderBy: undefined }, ['a', 'b'])).toBe('SELECT * FROM "s"."t"\nORDER BY "a" ASC, "b" ASC\nLIMIT 50 OFFSET 100');
  });

  it('mysql quotes with backticks', () => {
    expect(buildPageQuery('mysql', { ...spec, where: '' }, [])).toBe('SELECT * FROM `s`.`t`\nORDER BY `total` DESC\nLIMIT 50 OFFSET 100');
    expect(buildPageQuery('mysql', { ...spec, where: '', orderBy: [] }, [])).toBe('SELECT * FROM `s`.`t`\nLIMIT 50 OFFSET 100');
  });

  it('mssql uses OFFSET/FETCH and always has an ORDER BY', () => {
    expect(buildPageQuery('mssql', { ...spec, where: undefined, orderBy: undefined }, ['Id'])).toBe('SELECT * FROM [s].[t]\nORDER BY [Id] ASC\nOFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY');
    expect(buildPageQuery('mssql', { ...spec, where: undefined, orderBy: undefined }, [])).toBe('SELECT * FROM [s].[t]\nORDER BY (SELECT NULL)\nOFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY');
  });

  it('validates limit and offset', () => {
    expect(() => buildPageQuery('postgres', { ...spec, limit: 0 }, [])).toThrow(/Page size/);
    expect(() => buildPageQuery('postgres', { ...spec, limit: 1.5 }, [])).toThrow(/Page size/);
    expect(() => buildPageQuery('postgres', { ...spec, offset: -1 }, [])).toThrow(/Offset/);
  });

  it('counts with the same filter', () => {
    expect(buildCountQuery('mssql', { schema: 'dbo', table: 'T', where: 'x > 1;' })).toBe('SELECT COUNT_BIG(*) AS total FROM [dbo].[T]\nWHERE (\nx > 1\n)');
    expect(buildCountQuery('postgres', { schema: 'public', table: 't' })).toBe('SELECT COUNT(*) AS total FROM "public"."t"');
  });

  it('whereClause and orderClause edge cases', () => {
    expect(whereClause('   ')).toBe('');
    expect(whereClause(' a = 1 ;; ')).toBe('\nWHERE (\na = 1\n)');
    expect(orderClause('postgres', [], [])).toBe('');
    expect(orderClause('mysql', [{ column: 'a`b', desc: false }], [])).toBe('\nORDER BY `a``b` ASC');
  });
});

describe('row change SQL', () => {
  const changes: RowChangeSet = {
    updates: [{ pk: { id: int('1') }, set: { name: txt("O'Brien"), note: { t: 'null' }, active: { t: 'bool', v: true } } }],
    inserts: [{ id: int('2'), data: { t: 'json', v: { a: 1 } }, blob: { t: 'bytes', hex: 'cafe', length: 2 } }, {}],
    deletes: [{ id: int('3') }]
  };

  it('postgres: $n placeholders, deletes before updates before inserts, NULL inlined', () => {
    const stmts = buildChangeStatements('postgres', 'public', 'people', changes, ['id']);
    expect(stmts.map((s) => s.kind)).toEqual(['delete', 'update', 'insert', 'insert']);
    expect(stmts[0]).toMatchObject({ sql: 'DELETE FROM "public"."people" WHERE "id" = $1', params: [int('3')], expectOneRow: true });
    expect(stmts[1].sql).toBe('UPDATE "public"."people" SET "name" = $1, "note" = NULL, "active" = $2 WHERE "id" = $3');
    expect(stmts[1].params).toEqual([txt("O'Brien"), { t: 'bool', v: true }, int('1')]);
    expect(stmts[1].preview).toBe(`UPDATE "public"."people" SET "name" = 'O''Brien', "note" = NULL, "active" = TRUE WHERE "id" = 1`);
    expect(stmts[2].preview).toBe(`INSERT INTO "public"."people" ("id", "data", "blob") VALUES (2, '{"a":1}', '\\xcafe'::bytea)`);
    expect(stmts[2].expectOneRow).toBe(false);
    expect(stmts[3].sql).toBe('INSERT INTO "public"."people" DEFAULT VALUES');
  });

  it('mysql: ? placeholders and empty-insert syntax', () => {
    const stmts = buildChangeStatements('mysql', 'app', 'people', changes, ['id']);
    expect(stmts[1].sql).toBe('UPDATE `app`.`people` SET `name` = ?, `note` = NULL, `active` = ? WHERE `id` = ?');
    expect(stmts[2].preview).toBe("INSERT INTO `app`.`people` (`id`, `data`, `blob`) VALUES (2, '{\"a\":1}', X'cafe')");
    expect(stmts[3].sql).toBe('INSERT INTO `app`.`people` () VALUES ()');
  });

  it('mssql: @pN placeholders, N strings, 0x binary, bit booleans', () => {
    const stmts = buildChangeStatements('mssql', 'dbo', 'People', changes, ['id']);
    expect(stmts[1].sql).toBe('UPDATE [dbo].[People] SET [name] = @p1, [note] = NULL, [active] = @p2 WHERE [id] = @p3');
    expect(stmts[1].preview).toBe("UPDATE [dbo].[People] SET [name] = N'O''Brien', [note] = NULL, [active] = 1 WHERE [id] = 1");
    expect(stmts[2].preview).toBe(`INSERT INTO [dbo].[People] ([id], [data], [blob]) VALUES (2, N'{"a":1}', 0xcafe)`);
  });

  it('sqlite: ? placeholders and X literals', () => {
    const stmts = buildChangeStatements('sqlite', 'main', 'people', changes, ['id']);
    expect(stmts[0].sql).toBe('DELETE FROM "main"."people" WHERE "id" = ?');
    expect(stmts[2].preview).toContain("X'cafe'");
  });

  it('composite keys must be complete and exact', () => {
    const ok = buildChangeStatements('postgres', 's', 't', { updates: [], inserts: [], deletes: [{ a: int('1'), b: txt('x') }] }, ['a', 'b']);
    expect(ok[0].sql).toBe('DELETE FROM "s"."t" WHERE "a" = $1 AND "b" = $2');
    expect(() => buildChangeStatements('postgres', 's', 't', { updates: [], inserts: [], deletes: [{ a: int('1') }] }, ['a', 'b'])).toThrow(/exactly the primary key/);
    expect(() => buildChangeStatements('postgres', 's', 't', { updates: [], inserts: [], deletes: [{ a: int('1'), b: txt('x'), c: int('2') }] }, ['a', 'b'])).toThrow(/exactly the primary key/);
    expect(() => buildChangeStatements('postgres', 's', 't', { updates: [], inserts: [], deletes: [{ a: { t: 'null' }, b: txt('x') }] }, ['a', 'b'])).toThrow(/has no value/);
  });

  it('refuses tables without a primary key and truncated binary values', () => {
    expect(() => buildChangeStatements('postgres', 's', 't', { updates: [], inserts: [{ a: int('1') }], deletes: [] }, [])).toThrow(/no primary key/);
    expect(buildChangeStatements('postgres', 's', 't', { updates: [], inserts: [], deletes: [] }, [])).toEqual([]);
    const truncated: RowChangeSet = { updates: [{ pk: { id: int('1') }, set: { b: { t: 'bytes', hex: '00', length: 99999, truncated: true } } }], inserts: [], deletes: [] };
    expect(() => buildChangeStatements('postgres', 's', 't', truncated, ['id'])).toThrow(/truncated/);
  });

  it('skips updates with nothing to set', () => {
    expect(buildChangeStatements('postgres', 's', 't', { updates: [{ pk: { id: int('1') }, set: {} }], inserts: [], deletes: [] }, ['id'])).toEqual([]);
  });

  it('explains row mismatches', () => {
    const [stmt] = buildChangeStatements('postgres', 's', 't', { updates: [], inserts: [], deletes: [{ id: int('9') }] }, ['id']);
    const err = rowMismatchError(stmt, 0);
    expect(err.code).toBe('ROW_MISMATCH');
    expect(err.message).toMatch(/^Delete matched no row/);
    expect(rowMismatchError(stmt, 2).message).toMatch(/matched 2 rows/);
  });
});
