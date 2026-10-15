import { describe, expect, it } from 'vitest';
import {
  hasSqlContent,
  isReadOnlyScript,
  isReadOnlyStatement,
  leadingKeyword,
  parameterLiteral,
  qualifiedName,
  quoteIdent,
  scanParameters,
  singleSelectTarget,
  splitBatches,
  splitStatements,
  sqlLiteral,
  statementAt,
  stripComments,
  substituteParameters,
  substituteParametersMapped,
  writeKeyword
} from '@shared/sql';
import type { DbKind } from '@shared/types';

const texts = (sql: string, kind?: DbKind) => splitStatements(sql, kind).map((s) => s.text);
const isMulti = (sql: string, kind?: DbKind) => splitStatements(sql, kind).length > 1;

describe('leadingKeyword (dbTool leading_keyword_skips_comments)', () => {
  it('skips whitespace and comments', () => {
    expect(leadingKeyword('SELECT 1')).toBe('SELECT');
    expect(leadingKeyword('  select 1')).toBe('SELECT');
    expect(leadingKeyword('-- note\nSELECT 1')).toBe('SELECT');
    expect(leadingKeyword('-- a\n-- b\nWITH x AS (SELECT 1) SELECT * FROM x')).toBe('WITH');
    expect(leadingKeyword('/* block */ SELECT 1')).toBe('SELECT');
    expect(leadingKeyword('/* multi\nline */\n-- and line\nEXPLAIN SELECT 1')).toBe('EXPLAIN');
    expect(leadingKeyword('-- comment\nUPDATE t SET a = 1')).toBe('UPDATE');
    expect(leadingKeyword('/* unterminated')).toBe('');
    expect(leadingKeyword('-- only a comment')).toBe('');
    expect(leadingKeyword('')).toBe('');
  });

  it('skips leading parentheses', () => {
    expect(leadingKeyword('((SELECT 1)) UNION (SELECT 2)')).toBe('SELECT');
  });

  it('handles nested block comments in postgres', () => {
    expect(leadingKeyword('/* outer /* inner */ still comment */ DELETE FROM t', 'postgres')).toBe('DELETE');
  });
});

describe('splitStatements', () => {
  it('single statements are not multi (dbTool single_statement_is_not_multi)', () => {
    expect(isMulti('SELECT 1')).toBe(false);
    expect(isMulti('SELECT 1;')).toBe(false);
    expect(isMulti('SELECT 1;\n-- trailing comment')).toBe(false);
  });

  it('ignores semicolons in strings and comments (dbTool)', () => {
    expect(isMulti("SELECT 'a;b'")).toBe(false);
    expect(isMulti('SELECT 1 -- not; two\n')).toBe(false);
    expect(isMulti('SELECT 1 /* not; two */')).toBe(false);
    expect(isMulti('SELECT "col;on" FROM t')).toBe(false);
  });

  it('splits scripts (dbTool scripts_split_correctly)', () => {
    expect(texts('BEGIN; UPDATE t SET x = 1; COMMIT;')).toEqual(['BEGIN', 'UPDATE t SET x = 1', 'COMMIT']);
  });

  it('keeps dollar-quoted bodies whole (dbTool)', () => {
    const sql = 'CREATE FUNCTION f() RETURNS void AS $$ BEGIN; SELECT 1; END $$ LANGUAGE plpgsql';
    expect(isMulti(sql, 'postgres')).toBe(false);
    expect(splitStatements(`${sql}; SELECT 2`, 'postgres')).toHaveLength(2);
  });

  it('handles tagged dollar quotes containing $$', () => {
    const sql = "CREATE FUNCTION f() RETURNS text AS $body$ SELECT '$$;'; $body$ LANGUAGE sql; SELECT 1";
    expect(texts(sql, 'postgres')).toEqual(["CREATE FUNCTION f() RETURNS text AS $body$ SELECT '$$;'; $body$ LANGUAGE sql", 'SELECT 1']);
  });

  it('does not treat $1 placeholders or identifiers with $ as dollar quotes', () => {
    expect(texts('SELECT $1; SELECT a$b$ FROM t; SELECT 2', 'postgres')).toEqual(['SELECT $1', 'SELECT a$b$ FROM t', 'SELECT 2']);
  });

  it('handles escaped quotes inside literals (dbTool)', () => {
    expect(isMulti("SELECT 'it''s; fine'")).toBe(false);
    expect(isMulti("SELECT 'a'; SELECT 'b'")).toBe(true);
  });

  it('handles Postgres E strings with backslash escapes', () => {
    expect(texts("SELECT E'it\\'s; fine'; SELECT 2", 'postgres')).toEqual(["SELECT E'it\\'s; fine'", 'SELECT 2']);
  });

  it('handles MySQL backslash escapes, backticks, and # comments', () => {
    expect(texts("SELECT 'a\\';b'; SELECT `x;y` FROM t # c;d\n; SELECT 3", 'mysql')).toEqual([
      "SELECT 'a\\';b'",
      'SELECT `x;y` FROM t # c;d',
      'SELECT 3'
    ]);
  });

  it('treats `--` without a following space as minus minus in MySQL', () => {
    expect(texts('SELECT 1--1; SELECT 2', 'mysql')).toEqual(['SELECT 1--1', 'SELECT 2']);
  });

  it('handles SQL Server bracket identifiers', () => {
    expect(texts('SELECT [a;b]]c] FROM t; SELECT 2', 'mssql')).toEqual(['SELECT [a;b]]c] FROM t', 'SELECT 2']);
  });

  it('does not split inside parentheses', () => {
    expect(texts('CREATE RULE r AS ON INSERT TO t DO ALSO (INSERT INTO a VALUES (1); INSERT INTO b VALUES (2)); SELECT 1', 'postgres')).toHaveLength(2);
  });

  it('maps offsets back into the original script', () => {
    const sql = '  -- lead\n  SELECT 1 ;\n\n  SELECT 2;';
    const stmts = splitStatements(sql);
    for (const s of stmts) expect(sql.slice(s.start, s.end)).toBe(s.text);
    expect(stmts.map((s) => s.text)).toEqual(['-- lead\n  SELECT 1', 'SELECT 2']);
  });

  it('drops comment-only fragments', () => {
    expect(texts('-- a\n;\n/* b */;SELECT 1;-- tail')).toEqual(['SELECT 1']);
  });

  it('keeps MySQL procedure bodies whole', () => {
    const proc = 'CREATE PROCEDURE p()\nBEGIN\n  DECLARE x INT DEFAULT 0;\n  IF x = 0 THEN SELECT 1; END IF;\n  SELECT CASE WHEN x THEN 1 ELSE 2 END;\nEND';
    expect(texts(`${proc}; CALL p()`, 'mysql')).toEqual([proc, 'CALL p()']);
  });

  it('handles CASE statements and END CASE inside MySQL procedures', () => {
    const proc = 'CREATE PROCEDURE p(x INT)\nBEGIN\n  CASE x WHEN 1 THEN SELECT 1; ELSE SELECT 2; END CASE;\n  WHILE x > 0 DO SET x = x - 1; END WHILE;\nEND';
    expect(texts(`${proc}; SELECT 3`, 'mysql')).toEqual([proc, 'SELECT 3']);
  });

  it('supports the MySQL DELIMITER command', () => {
    const sql = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nCALL p();';
    expect(texts(sql, 'mysql')).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; END', 'CALL p()']);
  });

  it('keeps SQLite trigger bodies whole', () => {
    const trg = 'CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; DELETE FROM c; END';
    expect(texts(`${trg}; SELECT 1`, 'sqlite')).toEqual([trg, 'SELECT 1']);
  });

  it('keeps Postgres BEGIN ATOMIC bodies whole', () => {
    const fn = 'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END';
    expect(texts(`${fn}; SELECT 3`, 'postgres')).toEqual([fn, 'SELECT 3']);
  });

  it('does not treat BEGIN; as a block outside routines', () => {
    expect(texts('BEGIN; SELECT 1; END;', 'postgres')).toEqual(['BEGIN', 'SELECT 1', 'END']);
  });

  it('splits SQL Server scripts on GO lines', () => {
    const sql = 'SELECT 1\nGO\nSELECT 2; SELECT 3\n  go  \nPRINT 1\nGO 3\n';
    expect(texts(sql, 'mssql')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3', 'PRINT 1']);
    const batches = splitBatches(sql, 'mssql');
    expect(batches.map((b) => [b.text, b.repeat])).toEqual([
      ['SELECT 1', 1],
      ['SELECT 2; SELECT 3', 1],
      ['PRINT 1', 3]
    ]);
    for (const b of batches) expect(sql.slice(b.start, b.end)).toBe(b.text);
  });

  it('only treats GO as a separator for SQL Server and on its own line', () => {
    expect(texts('SELECT 1\nGO\nSELECT 2', 'postgres')).toEqual(['SELECT 1\nGO\nSELECT 2']);
    expect(texts("SELECT 'x\nGO\n' AS a; GOTO l", 'mssql')).toEqual(["SELECT 'x\nGO\n' AS a", 'GOTO l']);
    expect(texts('SELECT 1 -- x\nGO -- done\nSELECT 2', 'mssql')).toEqual(['SELECT 1 -- x', 'SELECT 2']);
  });

  it('keeps SQL Server module DDL to the end of its batch', () => {
    const proc = 'CREATE OR ALTER PROCEDURE dbo.p AS\nSET NOCOUNT ON;\nSELECT 1;\nSELECT 2;';
    expect(texts(`${proc}\nGO\nEXEC dbo.p;`, 'mssql')).toEqual([proc, 'EXEC dbo.p']);
  });

  it('keeps T-SQL BEGIN...END and TRY/CATCH blocks together', () => {
    const sql = 'IF 1 = 1\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND;\nBEGIN TRY\n  SELECT 1/0;\nEND TRY\nBEGIN CATCH\n  PRINT 1;\nEND CATCH;\nBEGIN TRAN; COMMIT;';
    expect(texts(sql, 'mssql')).toEqual([
      'IF 1 = 1\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND',
      'BEGIN TRY\n  SELECT 1/0;\nEND TRY\nBEGIN CATCH\n  PRINT 1;\nEND CATCH',
      'BEGIN TRAN',
      'COMMIT'
    ]);
  });

  it('splitBatches is per statement for other engines', () => {
    expect(splitBatches('SELECT 1; SELECT 2', 'postgres').map((b) => b.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('statementAt finds the statement under the cursor', () => {
    const sql = 'SELECT 1;\nSELECT 2;\n\nSELECT 3';
    expect(statementAt(sql, 0)?.text).toBe('SELECT 1');
    expect(statementAt(sql, sql.indexOf('2'))?.text).toBe('SELECT 2');
    expect(statementAt(sql, sql.indexOf('\n\n') + 1)?.text).toBe('SELECT 2');
    expect(statementAt('', 0)).toBeNull();
  });

  it('hasSqlContent and stripComments', () => {
    expect(hasSqlContent('-- x\n/* y */  ')).toBe(false);
    expect(hasSqlContent("'--'")).toBe(true);
    expect(stripComments("SELECT '--keep' -- drop\n, 1 /* x */")).toBe("SELECT '--keep'  \n, 1  ");
  });
});

describe('read-only classification', () => {
  it('permits reads (dbTool read_only_classifier_permits_reads)', () => {
    expect(writeKeyword('SELECT * FROM t')).toBeNull();
    expect(writeKeyword('EXPLAIN SELECT 1')).toBeNull();
    expect(writeKeyword('SHOW TABLES; SELECT 2')).toBeNull();
    expect(writeKeyword("SELECT 'drop table users'")).toBeNull();
    expect(writeKeyword('SELECT 1 -- update later\n')).toBeNull();
    expect(writeKeyword('SELECT updated_at FROM t')).toBeNull();
  });

  it('refuses writes (dbTool read_only_classifier_refuses_writes)', () => {
    expect(writeKeyword('UPDATE t SET x = 1')).toBe('UPDATE');
    expect(writeKeyword('SELECT 1; DROP TABLE t')).toBe('DROP');
    expect(writeKeyword('WITH d AS (SELECT 1) DELETE FROM t')).toBe('DELETE');
    expect(writeKeyword('EXPLAIN ANALYZE UPDATE t SET x = 1')).toBe('UPDATE');
    expect(writeKeyword('BEGIN; INSERT INTO t VALUES (1); COMMIT')).toBe('INSERT');
  });

  it('catches writes hidden inside reads', () => {
    expect(isReadOnlyStatement('WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x', 'postgres')).toBe(false);
    expect(isReadOnlyStatement('WITH x AS (SELECT 1) MERGE INTO t USING x ON true WHEN MATCHED THEN DELETE', 'postgres')).toBe(false);
    expect(isReadOnlyStatement('SELECT * INTO new_t FROM t', 'postgres')).toBe(false);
    expect(isReadOnlyStatement("SELECT nextval('s')", 'postgres')).toBe(false);
    expect(isReadOnlyStatement("SELECT set_config('default_transaction_read_only', 'off', false)", 'postgres')).toBe(false);
    expect(isReadOnlyStatement('SELECT * FROM t FOR UPDATE', 'postgres')).toBe(false);
    expect(isReadOnlyStatement("DO $$ BEGIN DELETE FROM t; END $$", 'postgres')).toBe(false);
    expect(isReadOnlyStatement('ANALYZE t', 'postgres')).toBe(false);
    expect(isReadOnlyStatement('CALL p()', 'mysql')).toBe(false);
  });

  it('allows function calls that share a name with write keywords', () => {
    expect(isReadOnlyStatement("SELECT replace(name, 'a', 'b') FROM t", 'postgres')).toBe(true);
    expect(isReadOnlyStatement("SELECT INSERT('Quadratic', 3, 4, 'What')", 'mysql')).toBe(true);
    expect(isReadOnlyStatement('SELECT t.update, delete.x FROM t', 'postgres')).toBe(true);
  });

  it('dollar-quoted text is opaque', () => {
    expect(isReadOnlyStatement('SELECT $$ DROP TABLE x $$', 'postgres')).toBe(true);
  });

  it('handles SET', () => {
    expect(isReadOnlyStatement("SET search_path TO sales, public", 'postgres')).toBe(true);
    expect(isReadOnlyStatement('SET NOCOUNT ON', 'mssql')).toBe(true);
    expect(isReadOnlyStatement('SET default_transaction_read_only = off', 'postgres')).toBe(false);
    expect(isReadOnlyStatement('SET TRANSACTION READ WRITE', 'postgres')).toBe(false);
    expect(isReadOnlyStatement('SET ROLE admin', 'postgres')).toBe(false);
    expect(isReadOnlyStatement('SET GLOBAL max_connections = 10', 'mysql')).toBe(false);
    expect(isReadOnlyStatement("SET PASSWORD = 'x'", 'mysql')).toBe(false);
  });

  it('handles PRAGMA', () => {
    expect(isReadOnlyStatement('PRAGMA table_info(t)', 'sqlite')).toBe(true);
    expect(isReadOnlyStatement('PRAGMA main.index_list("t")', 'sqlite')).toBe(true);
    expect(isReadOnlyStatement('PRAGMA foreign_keys', 'sqlite')).toBe(true);
    expect(isReadOnlyStatement('PRAGMA foreign_keys = OFF', 'sqlite')).toBe(false);
    expect(isReadOnlyStatement('PRAGMA journal_mode(WAL)', 'sqlite')).toBe(false);
    expect(isReadOnlyStatement('PRAGMA optimize', 'sqlite')).toBe(false);
  });

  it('handles transaction control and START', () => {
    expect(isReadOnlyScript('START TRANSACTION; SELECT 1; COMMIT', 'mysql')).toBe(true);
    expect(isReadOnlyStatement('START SLAVE', 'mysql')).toBe(false);
  });

  it('scans T-SQL batches that omit semicolons', () => {
    expect(isReadOnlyScript('SELECT 1 UPDATE t SET x = 1', 'mssql')).toBe(false);
    expect(isReadOnlyScript('DECLARE @id int = 5\nIF @id > 1\n  SELECT * FROM t WHERE id = @id\nELSE\n  PRINT 1', 'mssql')).toBe(true);
    expect(isReadOnlyScript("EXEC('SELECT 1')", 'mssql')).toBe(false);
    expect(isReadOnlyScript('SELECT @update = 1', 'mssql')).toBe(true);
    expect(isReadOnlyScript('sp_who2', 'mssql')).toBe(false);
    expect(isReadOnlyScript('SELECT 1\nGO\nBACKUP DATABASE x TO DISK = 1', 'mssql')).toBe(false);
    expect(isReadOnlyScript('SELECT * INTO #tmp FROM t', 'mssql')).toBe(false);
  });

  it('comment-only scripts are read-only', () => {
    expect(isReadOnlyScript('-- nothing here')).toBe(true);
  });
});

describe('parameters', () => {
  it('scans names (dbTool parameter_scanning)', () => {
    expect(scanParameters('SELECT * FROM t WHERE id = :id AND name = :name')).toEqual(['id', 'name']);
    expect(scanParameters('SELECT :a::int, :a, x := 1')).toEqual(['a']);
    expect(scanParameters("SELECT ':no' -- :no\n /* :no */ , $$ :no $$, :yes", 'postgres')).toEqual(['yes']);
    expect(scanParameters("SELECT '{}'::jsonb ? 'k'", 'postgres')).toEqual([]);
  });

  it('skips casts, slices, and quoted identifiers', () => {
    expect(scanParameters('SELECT x::text, arr[1:n], "a:b", [c:d] FROM t WHERE y = :y', 'postgres')).toEqual(['y']);
    expect(scanParameters('SELECT [x:y] FROM t WHERE a=:a', 'mssql')).toEqual(['a']);
    expect(scanParameters("SELECT E'\\':no' WHERE b = (:b)", 'postgres')).toEqual(['b']);
  });

  it('substitutes literals (dbTool parameter_substitution)', () => {
    expect(substituteParameters('SELECT * FROM t WHERE id = :id AND name = :name', { id: '42', name: "O'Brien" })).toBe(
      "SELECT * FROM t WHERE id = 42 AND name = 'O''Brien'"
    );
  });

  it('leaves unknown names and :: casts alone', () => {
    expect(substituteParameters('SELECT :a::int, :b', { a: '1' })).toBe('SELECT 1::int, :b');
  });

  it('renders literals per dialect (dbTool parameter_literals)', () => {
    expect(parameterLiteral('null')).toBe('NULL');
    expect(parameterLiteral('42')).toBe('42');
    expect(parameterLiteral('4.5')).toBe('4.5');
    expect(parameterLiteral('true')).toBe('TRUE');
    expect(parameterLiteral('true', 'mssql')).toBe('1');
    expect(parameterLiteral("it's")).toBe("'it''s'");
    expect(parameterLiteral("'007'")).toBe("'007'");
    expect(parameterLiteral('héllo', 'mssql')).toBe("N'héllo'");
    expect(parameterLiteral('C:\\temp', 'mysql')).toBe("'C:\\\\temp'");
  });

  it('maps substituted offsets back to the original', () => {
    const original = 'SELECT :long_name, bad_col FROM t';
    const { sql, toOriginalOffset } = substituteParametersMapped(original, { long_name: '1' });
    expect(sql).toBe('SELECT 1, bad_col FROM t');
    expect(toOriginalOffset(sql.indexOf('bad_col'))).toBe(original.indexOf('bad_col'));
    expect(toOriginalOffset(sql.indexOf('1'))).toBe(original.indexOf(':long_name'));
    expect(toOriginalOffset(0)).toBe(0);
  });
});

describe('identifiers and literals', () => {
  it('quotes identifiers', () => {
    expect(quoteIdent('postgres', 'a"b')).toBe('"a""b"');
    expect(quoteIdent('sqlite', 'x')).toBe('"x"');
    expect(quoteIdent('mysql', 'a`b')).toBe('`a``b`');
    expect(quoteIdent('mssql', 'a]b')).toBe('[a]]b]');
    expect(qualifiedName('mssql', 'dbo', 'T')).toBe('[dbo].[T]');
    expect(qualifiedName('postgres', '', 't')).toBe('"t"');
  });

  it('renders literals per dialect', () => {
    expect(sqlLiteral('postgres', { t: 'bytes', hex: '00ff', length: 2 })).toBe("'\\x00ff'::bytea");
    expect(sqlLiteral('mysql', { t: 'bytes', hex: '00ff', length: 2 })).toBe("X'00ff'");
    expect(sqlLiteral('mssql', { t: 'bytes', hex: '00ff', length: 2 })).toBe('0x00ff');
    expect(sqlLiteral('sqlite', { t: 'bytes', hex: '00ff', length: 2 })).toBe("X'00ff'");
    expect(sqlLiteral('postgres', { t: 'bool', v: true })).toBe('TRUE');
    expect(sqlLiteral('mysql', { t: 'bool', v: false })).toBe('FALSE');
    expect(sqlLiteral('mssql', { t: 'bool', v: true })).toBe('1');
    expect(sqlLiteral('sqlite', { t: 'bool', v: false })).toBe('0');
    expect(sqlLiteral('postgres', { t: 'json', v: { a: "it's" } })).toBe('\'{"a":"it\'\'s"}\'');
    expect(sqlLiteral('mssql', { t: 'text', v: 'é' })).toBe("N'é'");
    expect(sqlLiteral('mysql', { t: 'text', v: "a\\'b" })).toBe("'a\\\\''b'");
    expect(sqlLiteral('postgres', { t: 'int', v: '-9223372036854775808' })).toBe('-9223372036854775808');
    expect(sqlLiteral('postgres', { t: 'int', v: '1; DROP' })).toBe("'1; DROP'");
    expect(sqlLiteral('postgres', { t: 'decimal', v: '12.50' })).toBe('12.50');
    expect(sqlLiteral('postgres', { t: 'float', v: Number.NaN })).toBe("'NaN'::float8");
    expect(sqlLiteral('postgres', { t: 'null' })).toBe('NULL');
    expect(sqlLiteral('postgres', { t: 'datetime', v: '2025-01-01 00:00:00+00' })).toBe("'2025-01-01 00:00:00+00'");
  });
});

describe('singleSelectTarget (dbTool single_select_target_detection)', () => {
  it('detects plain single-table selects', () => {
    expect(singleSelectTarget('SELECT * FROM people')).toEqual({ table: 'people' });
    expect(singleSelectTarget('SELECT id, name FROM public.people WHERE age > 21 ORDER BY id')).toEqual({ schema: 'public', table: 'people' });
    expect(singleSelectTarget('select * from "Order Items" limit 5')).toEqual({ table: 'Order Items' });
    expect(singleSelectTarget('SELECT * FROM t WHERE id IN (SELECT tid FROM other JOIN x ON 1=1)')).toEqual({ table: 't' });
  });

  it('rejects other shapes', () => {
    expect(singleSelectTarget('SELECT * FROM a JOIN b ON a.id = b.id')).toBeNull();
    expect(singleSelectTarget('SELECT * FROM a, b')).toBeNull();
    expect(singleSelectTarget('SELECT * FROM a x, b y')).toBeNull();
    expect(singleSelectTarget('SELECT DISTINCT x FROM t')).toBeNull();
    expect(singleSelectTarget('SELECT x FROM t GROUP BY x')).toBeNull();
    expect(singleSelectTarget('SELECT 1; SELECT * FROM t')).toBeNull();
    expect(singleSelectTarget('UPDATE t SET x = 1')).toBeNull();
    expect(singleSelectTarget('SELECT count(*) FROM t')).toBeNull();
    expect(singleSelectTarget('SELECT * FROM (SELECT 1) s')).toBeNull();
    expect(singleSelectTarget('SELECT * FROM a UNION SELECT * FROM b')).toBeNull();
    expect(singleSelectTarget('SELECT * FROM a.b.c')).toBeNull();
  });

  it('allows ORDER BY lists and folds Postgres case', () => {
    expect(singleSelectTarget('SELECT * FROM Sales.Orders ORDER BY a, b', 'postgres')).toEqual({ schema: 'sales', table: 'orders' });
    expect(singleSelectTarget('SELECT * FROM "Sales".Orders', 'postgres')).toEqual({ schema: 'Sales', table: 'orders' });
    expect(singleSelectTarget('SELECT TOP 10 * FROM [dbo].[My Table] WITH (NOLOCK)', 'mssql')).toEqual({ schema: 'dbo', table: 'My Table' });
    expect(singleSelectTarget('SELECT * FROM `db`.`t`', 'mysql')).toEqual({ schema: 'db', table: 't' });
    expect(singleSelectTarget('SELECT * FROM ONLY t', 'postgres')).toEqual({ table: 't' });
  });
});
