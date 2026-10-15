# Database Tool

A desktop database client for **PostgreSQL**, **MySQL**, **SQL Server**, and **SQLite**, with an embedded Claude agent that can inspect schemas, run read-only queries, propose SQL, and run writes after you approve them.

Built with Electron, Svelte 5, Tailwind 4, and CodeMirror 6. The AI runs on the Claude Agent SDK and your existing Claude subscription login, so no API key is needed. Feature parity notes against the dbTool app this replaces are in `PLAN.md`.

## Requirements

- macOS on Apple Silicon. Only the arm64 build is set up.
- Node.js 22.12 or newer.
- pnpm 12. Running `corepack enable` once picks up the version pinned in `package.json`. You can also install pnpm yourself with `npm install -g pnpm`.
- The Claude CLI, signed in, for the AI panel (see below).

## Run it

```sh
git clone https://github.com/sunnymallick/database-tool.git
cd database-tool
pnpm install
pnpm dev          # development mode with hot reload
pnpm package:mac  # builds release/mac-arm64/Database Tool.app
```

The first `pnpm dev` downloads the Electron binary, so it takes a little longer.

Open `release/mac-arm64/Database Tool.app` to use the packaged app. It is unsigned, so if macOS blocks it, right-click it and choose Open.

To bring over your dbTool connections, use **Import from dbTool** on the welcome screen or in the sidebar header. Tick "Also import passwords" to copy them from dbTool's Keychain entries. macOS asks permission once per password.

**Opening and exporting files:**
- The folder button in a query tab's toolbar opens one or more `.sql` files. Each file gets its own tab, and an empty query tab is reused.
- **Export all** appears above the results when a run returns more than one result set. It saves them as separate CSV files in a folder you pick, or as one Excel workbook with a sheet per result plus a "Queries" sheet listing the SQL behind each. Each grid's own Export menu can also save a single result as Excel.
- Save dialogs reopen in the last folder you saved to. This is remembered until you quit the app.
- Exporting into a folder never overwrites existing files. It adds " (2)" to the name instead.

The AI panel needs the Claude CLI to be signed in. If the panel says you're signed out, run `claude` in a terminal and log in.

## Where things are stored

| What | Where |
|---|---|
| Profiles, settings, history, snippets, open tabs | `~/Library/Application Support/database-tool/` |
| Passwords | macOS Keychain, service `database-tool` |
| AI conversation transcripts (needed for follow-up turns) | `~/.claude/projects/` |

Set `DATABASE_TOOL_HOME` to use a different data folder, as the tests do. `pnpm dev` uses its own Electron profile folder, so it can run while the installed app is open.

## Safety model

- **Read-only profiles** refuse any statement that can write. The check runs in the main process, so it covers the editor, the table grids, and the AI.
- **Production profiles** get red accents everywhere. They ask for confirmation before write statements and before applying grid edits. The AI must get your approval for every write, even with "Allow writes" on.
- **The AI** can only use this app's database tools. Claude Code's built-in tools, your CLAUDE.md, your settings, and your MCP servers are all disabled for it.

## Develop

```sh
pnpm typecheck  # tsc (main) + svelte-check (renderer)
pnpm test       # vitest: unit, SQLite integration, Postgres integration, AI
pnpm fixtures   # (re)build tests/fixtures/sample.sqlite and the local Postgres DB database_tool_test
pnpm test:e2e   # builds, then drives the real Electron app (IPC smoke + file open/export)
pnpm test:tour  # builds, then clicks through the UI and saves screenshots
pnpm dev:web    # renderer only, in a browser, against an in-memory mock backend
```

The Postgres integration tests expect a local server with a `database_tool_test` database, which `pnpm fixtures` creates. They skip themselves when no server is reachable.

`pnpm-workspace.yaml` holds two settings to keep:
- `nodeLinker: hoisted` gives a flat `node_modules`. The app and electron-builder expect the Claude SDK's native binary at `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64`, which pnpm's default layout would hide.
- `allowBuilds` lists which dependencies may run install scripts. If a new dependency needs one, `pnpm install` stops and names it. Run `pnpm approve-builds <name>` to allow it.

Layout:

```
src/shared/     contract: data model (types.ts), IPC method/event map (api.ts), AI types, SQL + value helpers
src/main/       Electron main process: window, menu, IPC router, file dialogs
  db/           one driver per engine behind the Driver interface (db/driver.ts)
  connections/  profile store, Keychain secrets, connection registry + read-only guard, dbTool importer
  workspace/    history, snippets, settings, session
  ai/           Agent SDK provider, database tools, approvals, sessions
src/preload/    the IPC bridge exposed to the window
src/renderer/   Svelte UI: shell, tree, editor, grid, table and structure tabs, AI panel, browser mock
tests/          unit, integration, ai, e2e
```

## Known gaps

- MySQL and SQL Server drivers are tested against scripted fakes only. No live server was available while building them.
- SSH tunnels are not supported yet. Imported SSH profiles connect directly and show a warning.
- SQLite queries run on the main process thread, so a very long single SQLite statement can't be cancelled mid-step.
- SQL Server DECIMAL/MONEY beyond about 15 significant digits loses precision, and `datetimeoffset` displays in UTC. Both come from the tedious driver.
- Saving a password passes it to the `security` command as an argument, so it is briefly visible to other processes of your own user.
