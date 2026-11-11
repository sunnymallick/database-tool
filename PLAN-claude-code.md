# Claude Code integration: `db-tool` MCP server + CLI

Status: **built** (2026-11-11). User docs are in README, "Use it from Claude Code".

## Decisions (confirmed by the user, 2026-11-11)

1. The command is named `db-tool`.
2. Access is a simple on/off per connection (`claudeCodeAccess`), and it is **read-only only**. There is no write path from Claude Code at all.
3. The MCP server is registered **per project** (`claude mcp add` in the project folder). `--connections` narrows the connections further.
4. Production connections are always read-only. This holds automatically, since every exposed connection is read-only.

## As built

| Piece | Where |
|---|---|
| Profile field `claudeCodeAccess` (default false) | `src/shared/types.ts`, `connections/store.ts` `normalizeProfile` |
| Access gate: visibility, `--connections` scope, forced `readOnly`, database allowlist | `src/main/external/access.ts` |
| Services: `LiveProfiles` (mtime reload), a Registry over exposed profiles, closes stale connections | `src/main/external/services.ts` |
| MCP tools (`list_connections`, `list_schemas`, `list_tables`, `describe_table`, `table_ddl`, `run_select`), reusing `ToolHost` | `src/main/external/tools.ts` |
| Audit log `claude-code-audit.jsonl` | `src/main/external/audit.ts` |
| CLI (`connections`/`schemas`/`tables`/`describe`/`ddl`/`query`/`mcp`) | `src/cli/run.ts`, `format.ts`, `index.ts` |
| stdio MCP server (low-level `Server`, zod → JSON Schema) | `src/cli/mcp.ts` |
| Install link `~/.local/bin/db-tool` | `src/main/external/install.ts`, `src/main/ipc/claude-code.ts` |
| Shim run with `ELECTRON_RUN_AS_NODE` | `resources/bin/db-tool` → `Contents/Resources/bin/` (electron-builder `extraResources`) |
| Build entry | `electron.vite.config.ts` main input `cli` → `out/main/cli.js` |
| UI | ConnectionDialog switch, ConnectionTree `>_` badge, Settings → Claude Code |

### Layers of read-only enforcement
1. The statement check (`isReadOnlyScript`) runs before anything executes.
2. Profiles are forced to `readOnly: true`, so the driver opens a read-only session: Postgres `default_transaction_read_only`, MySQL `SET SESSION TRANSACTION READ ONLY`, SQLite opened read-only.
3. The Registry wraps the driver in `readOnlyDriver`, the same guard the app uses.

### Tests
- `tests/unit/external-access.test.ts`
- `tests/unit/external-install.test.ts`
- `tests/integration/external.test.ts`: a real MCP client over an in-memory transport, the CLI, SQLite, and local Postgres.

The packaged app was smoke-tested from `release/`: CLI commands, and the MCP server over real stdio.

## Possible follow-ups (not built)
- Show `claude-code-audit.jsonl` in the History panel.
- Live bridge to the running app (read the open editor, push SQL into a tab).
- A Claude Code plugin/skill that bundles the MCP registration and usage conventions.
