# database-tool: evaluation of dbTool and build plan

Date: 2026-10-13
Reference implementation: `/Users/sunnymallick/red-sky/thomas-dbtool/dbTool` (Rust, v0.4.4, ~35.5k LOC, 42 commits)
Target: `/Users/sunnymallick/personal-projects/database-tool` (currently empty)
Status: POC BUILT 2026-10-13 (see README.md for running it). Decisions confirmed 2026-10-13 (see section 0). Sections 2.1 to 2.5 describe the
original web-app proposal; section 0 records what changed for the desktop build.

## 0. Confirmed decisions and as-built architecture

| Question | Decision |
|---|---|
| Web app or desktop app | Desktop app. Built with Electron 44 because the Agent SDK is a Node library, so Node must run in-process. Tauri would need a Rust shell plus a Node sidecar. |
| AI backend | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.x) on the user's Claude subscription. The SDK bundles a native `claude` binary. |
| Passwords | macOS Keychain via the `security` CLI, with a 0600 file fallback. |
| Engines | PostgreSQL, MySQL, SQL Server, SQLite (SQLite via built-in `node:sqlite`, so no native modules). |

As-built layout (replaces 2.3; the REST routes in 2.5 became IPC methods):

```
src/shared/      types.ts (data model), api.ts (IPC method + event map), ai.ts, values.ts, sql.ts
src/main/        index.ts (window, lifecycle), menu.ts, paths.ts, errors.ts, services.ts
  ipc/           router.ts (single invoke channel), files.ts (dialogs, allowlisted file IO), data.ts, ai.ts
  db/            driver.ts (Driver contract) + one module per engine
  connections/   profile store, keychain secrets, registry, dbTool importer
  workspace/     history, snippets, settings, session
  ai/            Agent SDK provider, MCP tools, sessions
src/preload/     contextBridge -> window.bridge (invoke + events)
src/renderer/    Svelte 5 + Tailwind 4 UI; lib/api.svelte.ts typed client; lib/mock/ browser-only mock backend
tests/           unit, integration (SQLite fixture + local Postgres `database_tool_test`), ai, e2e (Playwright _electron)
```

Toolchain: electron-vite 5, Vite 7, Svelte 5, @sveltejs/vite-plugin-svelte 6, Tailwind 4, bits-ui 2, CodeMirror 6,
TypeScript 5.9, vitest 5, pnpm. Data lives in `~/Library/Application Support/database-tool` (override: `DATABASE_TOOL_HOME`).


---

## 1. Evaluation of dbTool

### 1.1 Architecture

| Layer | How dbTool does it | Files |
|---|---|---|
| UI | egui/eframe 0.28 immediate-mode GUI, single native binary (macOS/Linux/Windows) | `app.rs` (6.3k lines), `ui/*` |
| Async bridge | Dedicated tokio runtime thread. UI sends a `Command` enum, gets events back keyed by request id | `runtime.rs` |
| DB abstraction | `Driver` async trait with a shared `Value` enum (`Null/Bool/Int/Float/Text/Bytes/Json/Timestamp`), `ResultSet`, `TableSchema`, `TableMeta`, `DbMeta`, `TableStructure` | `db/mod.rs`, `db/types.rs`, `db/structure.rs` |
| Drivers | Postgres (sqlx), MySQL (sqlx), SQLite (sqlx), MSSQL (tiberius) | `db/postgres.rs`, `db/mysql.rs`, `db/sqlite.rs`, `db/mssql.rs` |
| SQL text handling | Statement splitting (comment and dollar-quote aware), leading keyword classification, write classifier for read-only profiles, `:name` parameter scan + literal substitution, single-select-target detection (makes results editable), routine DDL detection | `db/mod.rs` |
| Connections | JSON profiles at `~/Library/Application Support/dbTool/connections.json`; passwords in OS keyring with plaintext fallback; SSH tunnel through system `ssh`; multiple databases per server profile; colours; `production` and `read_only` flags | `connections/*` |
| AI | Spawns `claude -p --output-format stream-json`; in-process axum HTTP MCP server; write tools block on user approval; `--resume` for continuity; CLI auto-detect across install dirs; built-in tools disabled with `--tools ""` | `ai_session.rs`, `mcp_server.rs`, `ai_tools.rs`, `claude_auth.rs` |
| Persistence | `settings.json`, `history.jsonl`, `snippets.json`, `session.json` (restores open tabs) | `settings.rs`, `history.rs`, `snippets.rs`, `session.rs` |
| Completion | Hand-written lexer, scope/context analysis, fuzzy candidates (nucleo), schema cache (~2k lines) | `sql_complete/*` |
| Structure editing | Working-copy model with change tracking; generates CREATE/ALTER per dialect incl. SQLite table rebuild, with danger flags | `db/structure.rs` |
| Compare / sync | Schema diff; data diff (checksum + PK-ordered), sync script, column masking | `db/compare.rs`, `db/datasync.rs` |
| Diagrams | DBML parse/render, pan/zoom canvas, SVG export | `dbml.rs`, `ui/diagram_*` |
| Tests | In-module unit tests; integration suites for sqlite, datasync, postgres (needs server), sql_complete | `tests/*` |
| Release | GitHub CI + release workflows, Windows installer, macOS dmg, in-app update check | `.github/*`, `installer/*`, `update.rs` |

### 1.2 Feature inventory

**Connections**
- Profiles for PostgreSQL, MySQL, MSSQL, SQLite; test, connect, disconnect, auto-reconnect
- SSH tunnels (host, port, user, key)
- SSL toggle
- OS keyring password storage with plaintext fallback
- Multiple databases per server profile, each a sidebar node
- Accent colours per connection and per database
- Production flag: red-tinted UI, protected from data pulls
- Read-only flag: write classifier blocks writes, editor commits, and DDL
- Session restore of open query tabs

**SQL editor**
- Multiple tabs, each bound to a connection; open/save to file
- Syntax highlighting, line numbers, find/replace
- Schema-aware fuzzy completion (tables, columns, functions, keywords, alias scopes)
- Run selection, statement at cursor, or whole script; multi-statement scripts
- `:name` parameters with a prompt dialog
- SQL formatting
- Error to cursor jump (Postgres error position)
- Saved snippets
- Persistent query history
- Per-tab auto-refresh
- Manual transactions (BEGIN / COMMIT / ROLLBACK sessions)
- Server-side query cancel
- Keyboard shortcut cheatsheet

**Results grid**
- Sorting, filtering, grid find
- Streamed row cap with "fetch all rows"
- In-place cell editing on single-table selects; row insert and delete
- Modal JSON cell editor with validation and pretty-print
- Foreign-key hover peek
- Column statistics
- Copy/export as CSV, JSON, INSERT statements, Markdown
- Table row totals

**Schema tools**
- Sidebar tree: schemas, tables, views, functions/procedures, sequences, enums, triggers; filter box
- Table data tab: paged rows, WHERE filter, sort, edit/insert/delete
- Table structure editor: columns, PK, indexes, FKs, checks; generated ALTER script; SQLite rebuild
- DDL dump; table and column comments; routine source view and edit
- Users and roles; sessions monitor with kill
- Visual EXPLAIN plans
- Whole-database dump and restore via pg_dump/pg_restore and mysqldump/mysql
- CSV import and export

**Cross-connection**
- Structure compare: migration diff between two connections with per-change checkboxes
- Data compare and sync: checksum + PK-ordered row diff, sync script generation
- Sanitised data pulls with in-flight masking (NULL, fixed, deterministic hash, faker)
- Transfer tab: column-mapped cross-engine data transfer with SQL expressions and new-id lookup maps

**Diagrams**
- DBML editor with live source pane, pan/zoom canvas, draggable tables, FK curves, table groups, snap guides
- Introspect any database straight into a DBML document
- SVG export

**AI**
- Embedded Claude agent through the `claude` CLI and an in-process MCP server (uses the Claude subscription, no API key)
- Selectable connection and model; "allow writes" toggle; approval cards for writes
- Tools: run_select, run_statement, list_dbml, read_dbml, update_dbml, focus_table, read_editor, propose_sql, read_transfer, propose_mapping
- propose_sql cards with copy / open in new tab / replace editor actions

**App**
- Dark and light themes, settings dialog, update check, cross-platform packaging

### 1.3 Strengths worth carrying over
- A clean driver abstraction with one shared value model across engines.
- A layered safety model: read-only classifier at the driver boundary, production tint, approval-gated AI writes.
- AI through the Claude subscription, with the model restricted to tools the app exposes.
- Careful SQL text handling (comments, dollar quotes, parameters, statement splitting).
- A restorable workspace: tabs, history, snippets, settings.

### 1.4 Friction points that justify a separate tool
- `app.rs` holds most UI state in one 6.3k-line struct; adding a tab type touches many places.
- The editor, completion popup, and grid are hand-rolled for egui (~3k lines) and are hard to extend.
- Rust compile times for sqlx + tiberius + egui make iteration slow.
- The owner wants the design kept as-is, so new features need a different home.

---

## 2. Proposed design for database-tool

### 2.1 Stack (recommended, pending confirmation)

| Concern | Choice | Why |
|---|---|---|
| Language / UI | SvelteKit + Svelte 5 (runes) + TypeScript, Tailwind 4, lucide icons | Matches the user's existing Svelte/TS work and review agents; richest UI per hour of work |
| Runtime | Node 22 (installed 22.21), pnpm, adapter-node; one local process serving UI + API on 127.0.0.1 | Single language, single process, easy to extend |
| Drivers | `pg`, `mysql2`, `mssql` (tedious), `better-sqlite3` (fallback `node:sqlite`) | Mature drivers for all four engines dbTool supports; MSSQL is required because the user's real profiles are SQL Server |
| SQL editor | CodeMirror 6 + `@codemirror/lang-sql` | Dialects, highlighting, and schema-driven completion come built in; replaces dbTool's 2k-line completion engine |
| SQL formatting | `sql-formatter` | Per-dialect formatting |
| Grid | Custom virtualised Svelte grid | Full control over editing, selection, copy |
| AI | `@anthropic-ai/claude-agent-sdk` (0.3.x pairs with the installed `claude` 2.1.296 CLI) with in-process MCP tools, `canUseTool` for approvals, SSE to the browser | Same approach as dbTool (subscription auth, no API key) but first-class in TypeScript |
| Tests | vitest, svelte-check, playwright-cli smoke | Unit tests for SQL helpers, SQLite in-memory integration, Postgres integration against the local server |
| Packaging | Later: Tauri 2 sidecar or Electron shell | Optional; the Node server can be wrapped without rewriting |

**Alternative considered: Tauri 2 + Svelte + Rust backend.** Native window, and dbTool's `db/` modules could be lifted nearly verbatim. Rejected for the POC: two languages, long Rust compile times, and it keeps the project tied to the coworker's design. The SvelteKit server can become a Tauri sidecar later if a native window matters.

**Alternative for AI: direct Anthropic API with an API key** (Claude Opus 5.5 via the Messages API tool runner). No `ANTHROPIC_API_KEY` is set on this machine and dbTool already uses the subscription path, so the Agent SDK is the default. Design the AI module behind a small provider interface so an API-key provider can be added later.

### 2.2 Local server security
The API executes SQL, so the local server must not be reachable from a web page:
- Bind to 127.0.0.1 only.
- Host-header allowlist (`localhost`, `127.0.0.1`) to block DNS rebinding.
- Require a custom request header on every mutating route (browsers will not send it cross-origin without CORS, which stays disabled).
- Per-launch random token embedded in the page and sent as a header (cheap, do it in the POC).

### 2.3 Directory layout

```
database-tool/
  package.json, pnpm-lock.yaml, svelte.config.js, vite.config.ts, tsconfig.json, tailwind config
  PLAN.md, README.md
  bin/database-tool.js            # starts the built server on a free localhost port and opens the browser
  src/
    lib/
      types.ts                    # shared client/server contracts (Value, ResultSet, ConnectionProfile, ...)
      server/
        db/
          types.ts                # Driver interface
          sql.ts                  # splitStatements, leadingKeyword, isReadOnly, scanParams, substituteParams, quoteIdent
          postgres.ts  mysql.ts  mssql.ts  sqlite.ts
          index.ts                # connect(profile, password): Driver
        connections/
          store.ts                # profiles JSON in the OS config dir
          secrets.ts              # macOS Keychain via `security` CLI; file fallback (0600)
          registry.ts             # live Driver instances keyed by profile id; connect/disconnect/health
          import-dbtool.ts        # one-click import of dbTool's connections.json (no passwords)
        ai/
          provider.ts             # AiProvider interface (startTurn, approve, cancel)
          agent-sdk.ts            # Claude Agent SDK implementation
          tools.ts                # MCP tool definitions + execution against the registry
          sessions.ts             # in-memory session map, event buffers, approval channels
        history.ts  snippets.ts  settings.ts  session.ts  paths.ts  guard.ts
      components/
        shell/      (AppShell, Sidebar, TabBar, StatusBar, CommandPalette)
        connections/(ConnectionList, ConnectionDialog)
        schema/     (SchemaTree, TableStructure)
        editor/     (SqlEditor, ParamsDialog, HistoryPanel, SnippetsPanel)
        grid/       (ResultsGrid, CellEditor, JsonCellEditor, ExportMenu)
        table/      (TableDataTab, PendingChangesBar)
        ai/         (AiPanel, ToolCard, ApprovalCard, ProposeSqlCard)
      stores/       (connections.svelte.ts, tabs.svelte.ts, settings.svelte.ts, ai.svelte.ts)
      api/          (typed fetch client for the routes below)
    routes/
      +layout.svelte, +page.svelte
      api/... (+server.ts per route, see 2.5)
  tests/
    unit/ (sql helpers, value coercion, export encoders)
    integration/ (sqlite in-memory; postgres gated by DATABASE_TOOL_TEST_PG; mysql/mssql gated by env)
  docs/API.md                     # the contract the three agents build against
```

### 2.4 Core interfaces (sketch)

```ts
// src/lib/types.ts
export type DbKind = 'postgres' | 'mysql' | 'mssql' | 'sqlite';
export type Value =
  | { t: 'null' } | { t: 'bool'; v: boolean } | { t: 'int'; v: string /* bigint-safe */ }
  | { t: 'float'; v: number } | { t: 'text'; v: string } | { t: 'bytes'; v: string /* hex */ }
  | { t: 'json'; v: unknown } | { t: 'timestamp'; v: string };
export interface Column { name: string; typeName: string }
export interface ResultSet { columns: Column[]; rows: Value[][]; rowsAffected?: number; truncated: boolean }
export interface ColumnSchema { name: string; typeName: string; nullable: boolean; isPrimaryKey: boolean; default?: string }
export interface TableInfo { schema: string; name: string; kind: 'table' | 'view'; comment?: string }
export interface TableStructure { columns: ColumnSchema[]; primaryKey: string[]; foreignKeys: ForeignKey[]; indexes: IndexInfo[]; ddl?: string }
export interface ConnectionProfile { id: string; name: string; kind: DbKind; host: string; port: number; database: string;
  username: string; ssl: boolean; filePath?: string; color?: string; production: boolean; readOnly: boolean;
  options?: Record<string, string> /* e.g. trustServerCertificate */ }

// src/lib/server/db/types.ts
export interface Driver {
  kind: DbKind;
  ping(): Promise<void>;
  listDatabases(): Promise<string[]>;
  listSchemas(): Promise<string[]>;
  listTables(schema: string): Promise<TableInfo[]>;
  describeTable(schema: string, table: string): Promise<TableStructure>;
  tableDdl(schema: string, table: string): Promise<string>;
  query(sql: string, opts: { rowCap: number; signal?: AbortSignal }): Promise<ResultSet[]>;   // multi-statement
  fetchRows(schema: string, table: string, q: { where: string; order: [string, boolean][]; limit: number; offset: number }): Promise<{ rows: ResultSet; total: number }>;
  applyChanges(schema: string, table: string, changes: RowChanges, opts: { preview: boolean }): Promise<{ sql: string[]; applied?: number }>;
  fetchMeta(): Promise<DbMeta>;    // for completion
  cancel?(queryId: string): Promise<void>;
  close(): Promise<void>;
}
```

Read-only enforcement lives in the registry wrapper, not in each driver, so no driver can forget it: every statement passes through `isReadOnlyStatement()` when the profile is read-only; production profiles always require AI approval for writes.

### 2.5 API contract (REST + SSE, all under /api, JSON)

```
Connections
  GET    /connections                        -> ConnectionProfile[] (never includes secrets)
  POST   /connections                        {profile, password?}  -> profile
  PUT    /connections/:id                    {profile, password?}  -> profile
  DELETE /connections/:id
  POST   /connections/:id/test               -> {ok, message, serverVersion?}
  POST   /connections/:id/connect            -> {ok, databases?, defaultSchema}
  POST   /connections/:id/disconnect
  POST   /connections/import-dbtool          -> {imported: number, skipped: string[]}
  GET    /connections/status                 -> {[id]: 'connected'|'disconnected'|'error'}

Database (id = profile id)
  GET    /db/:id/databases
  GET    /db/:id/schemas
  GET    /db/:id/tables?schema=
  GET    /db/:id/tables/:schema/:table/structure
  GET    /db/:id/tables/:schema/:table/ddl
  GET    /db/:id/tables/:schema/:table/rows?limit&offset&where&order
  POST   /db/:id/tables/:schema/:table/changes   {updates, inserts, deletes, preview}
  POST   /db/:id/query                           {sql, params?, unlimited?, queryId}  -> {results: ResultSet[], durationMs, error?: {message, position?}}
  POST   /db/:id/cancel                          {queryId}
  GET    /db/:id/meta                            -> DbMeta (tables + columns, for completion)

Workspace
  GET/POST  /history        GET/PUT /snippets      GET/PUT /settings      GET/PUT /session

AI
  POST   /ai/sessions                        {connectionId?, prompt, resumeId?, allowWrites, model}  -> {sessionId}
  GET    /ai/sessions/:id/events             SSE: text_start | text_delta | tool_start | tool_ready | tool_result | turn_done | error
  POST   /ai/sessions/:id/approve            {toolUseId, approved}
  POST   /ai/sessions/:id/cancel
  GET    /ai/status                          -> {cliFound, cliPath, version, loggedIn}
```

### 2.6 AI design
- Provider interface so the Agent SDK is one implementation; an API-key implementation can follow.
- Agent SDK session: `query({ prompt, options: { mcpServers: { dbtool: createSdkMcpServer(...) }, allowedTools: [mcp__dbtool__*], tools: [] /* no built-ins */, permissionMode, canUseTool, resume, model, systemPrompt, cwd: <empty workspace dir> } })`. Exact option names to be verified against the SDK docs at build time.
- Tools (POC): `list_schemas`, `list_tables`, `describe_table`, `run_select` (read-only classifier enforced), `run_statement` (approval-gated), `read_editor`, `propose_sql`.
- Approval: `canUseTool` blocks until the UI posts an approval; "allow writes" toggle skips it except on production profiles.
- Streaming: server pushes SSE events; the panel renders text, tool cards, approval cards, and propose_sql cards with copy / open in new tab / replace editor.
- Result payload caps: 100 rows and 50 KB per tool result, like dbTool.
- Context: system prompt carries engine, dialect notes, current connection, and a compact schema summary.

---

## 3. Execution plan

### Phase 0: scaffold (main agent, sequential, before any subagent runs)
1. `pnpm dlx sv create` with TypeScript, Tailwind, vitest; adapter-node; pin versions that pass a clean build.
2. Write `src/lib/types.ts`, `src/lib/server/db/types.ts`, `docs/API.md`, and stub `+server.ts` files returning 501 so the contract is fixed.
3. Add `paths.ts` (config dir: `~/Library/Application Support/database-tool` on macOS, XDG on Linux, APPDATA on Windows) and `guard.ts` (localhost security from 2.2).
4. Create a tiny SQLite fixture and a Postgres fixture script for the local server (`carsrus` or a new `database_tool_test` DB).

### Phase 1: three subagents in parallel (one Workflow run, 3 agents, the user's cap)

| Agent | Owns | Deliverables | Done when |
|---|---|---|---|
| A: data layer | `src/lib/server/db/*`, `connections/*`, workspace persistence, all non-AI `/api` routes, `tests/` | 4 drivers, SQL helpers ported from dbTool (with its edge cases as tests), registry with read-only enforcement, keychain, import-dbtool, history/snippets/settings/session | vitest green: unit + SQLite integration + Postgres integration against local server; routes exercised with curl |
| B: UI | `src/lib/components/*`, `stores/*`, `api/*`, routes' Svelte files | App shell, sidebar schema tree, tabs, CodeMirror editor with completion/format/params, results grid with export and JSON viewer, table data tab with pending changes and SQL preview, structure view, connection dialog, production tint, shortcuts | svelte-check clean; works against a mock API mode so it can be built without A |
| C: AI | `src/lib/server/ai/*`, `/api/ai/*`, `components/ai/*`, `stores/ai.svelte.ts` | Agent SDK provider, MCP tools over the registry interface, SSE streaming, approval flow, AI panel with tool/approval/propose cards, CLI status check, model picker | Unit tests with a fake provider; a live smoke turn against SQLite via the installed `claude` CLI |

Each agent gets: the API contract, the shared types, the relevant dbTool source paths to port from, and a rule to touch only its own directories.

### Phase 2: integration and verification (main agent)
1. Merge, run `svelte-check`, `vitest`, `pnpm build`.
2. Launch the built server, run smoke tests with curl and playwright-cli against local Postgres and the SQLite fixture: connect, browse, query, edit a row, export, AI turn with an approval.
3. Fix integration issues; write `README.md` (install, run, config paths, how to add a driver or AI tool).
4. Stop every server started for testing.

### Phase 3: roadmap after the POC (pick by priority)
- Table structure editor with generated ALTER scripts (port `db/structure.rs`)
- SSH tunnels (system `ssh` like dbTool, or `ssh2`)
- Schema compare and data compare/sync with masking
- Cross-engine transfer with column mapping
- EXPLAIN visualiser, sessions monitor, users/roles
- CSV import; dump/restore wrappers
- ER diagrams from live schema (DBML or Mermaid)
- Saved query library with folders and per-connection workspaces
- Charts from result sets
- AI: schema-aware NL to SQL with examples, multi-step data tasks, API-key provider, per-tool audit log
- MSSQL extras: stored procedure runner with parameters, multiple result sets, linked servers
- Desktop shell (Tauri 2 sidecar), auto-update, packaging

---

## 4. Decisions to confirm before building
1. Stack: SvelteKit local web app (default) vs Tauri desktop app with a Rust backend.
2. AI backend: Claude Agent SDK through the installed `claude` CLI and subscription (default) vs Anthropic API key.
3. Password storage: macOS Keychain via the `security` CLI with file fallback (default).
4. Engines in the POC: all four (default). MySQL cannot be integration-tested here (no local MySQL, no Docker); MSSQL only against the user's real sandbox if they choose to.
5. Any specific features the user wants that dbTool lacks, to pull into the POC scope.

## 5. Risks and mitigations
- pnpm 10+ blocks postinstall scripts: add `pnpm.onlyBuiltDependencies` for `better-sqlite3`, or use `node:sqlite` instead.
- Agent SDK option names drift between versions: verify against the SDK README for the installed version before coding; keep the provider interface thin.
- Very new SvelteKit 3 / Vite 8: use whatever `sv create` pins; if the template is unstable, pin SvelteKit 2.x.
- MSSQL TLS to the user's servers: expose `encrypt` and `trustServerCertificate` options in the profile dialog.
- Large result sets: enforce the row cap in each driver's streaming path, not after materialising.
- Query cancel differs per engine: pg uses `pg_cancel_backend` from a second connection; mysql uses `KILL QUERY`; mssql uses request cancel; sqlite has no cancel in the POC.
