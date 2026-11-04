# AGENTS.md — ChatVault

Agent-facing development guide. Product overview and installation: [README.md](README.md).

## Purpose

ChatVault indexes conversations from multiple AI tools into local SQLite. People read and search through the Web UI; agents read the same archive through HTTP MCP. Preserve source attribution and keep archive ingestion read-only with respect to agent source directories.

Runtime: Node.js >= 22.19, built-in `node:sqlite` and FTS5. No dependency installation or frontend build is needed for the application. Default URL: `http://127.0.0.1:8377`; MCP: `/mcp`.

## Start here

```sh
node bin/chat-vault.js serve --port 8377
node bin/chat-vault.js sync
node bin/chat-vault.js search "example"
node bin/chat-vault.js stats
```

Use an isolated database for tests and smoke checks. Do not alter a user's live archive or run full sync against personal sources as part of testing. `serve --no-sync --no-watch --db <test.db>` starts an isolated reader.

## Layout

```text
src/adapters/       Source parsers -> unified session model
src/sync.js         Discover, fingerprint, parse and upsert
src/db.js           SQLite schema, migrations and FTS
src/query.js        Search, sessions, workspaces and conversation chains
src/mcp-tools.js    Shared read tools for MCP and the UI assistant
src/server.js       HTTP API, SSE, UI assets and MCP
src/runtime.js      Explicit user-initiated agent execution
src/backup*.js      Consistent snapshots, upload and restore
src/pi-sessions.js Optional local Pi session controls and connection text
src/cli.js          Command-line interface
ui/                Vanilla JavaScript SPA, no build
extensions/        Optional ChatGPT browser sync extension
integrations/      Optional reusable Pi integrations
```

## Working conventions

- Use `rg` for searches. Keep adapters self-contained; follow [the adapter guide](docs/AGENT-INTEGRATION-GUIDE.md).
- Never commit credentials, archive databases, conversation exports, browser captures, personal deployment receipts or machine-specific launchers. Use fictional fixtures and example paths/hosts.
- Prefer `127.0.0.1` over `localhost`. Do not expose local runtime controls through LAN endpoints.
- Keep MCP archive queries read-only. Adding a query tool in `mcp-tools.js` also exposes it to the UI assistant; execution tools do not belong in that read layer.
- Large sessions require pagination and bounded output. Preserve source session IDs and message coordinates when merging views.
- Inspect an existing process/job before retrying a write or launch after an observation timeout.
- Optional Chappie/Pi integrations must not impose authentication, recovery-token or event-subscription requirements on ordinary archive reads.
- For browser experiments, inspect existing evidence first. Disclose the target chat and message count before sending; use one experimental tab at a time. Do not refresh or stop an active user run without authorization.

## Verification

```sh
node --test test/*.test.js
npm run verify:chatgpt
```

Check changed JavaScript with `node --check`. Test adapters with synthetic source fixtures and a temporary `openDb(testPath)` database. A release also needs a fresh-data-directory CLI/UI/MCP smoke test and an audit of the actual packaged files.

## Performance invariants

- `sendJson` compresses by default, using `res.req` when no explicit request is provided. Keep compression for large responses.
- Preserve `LENGTH(TRIM(content_text)) <= 64` in both `idx_messages_user_text` and its matching retry-message query.
- SQLite free pages require explicit VACUUM. Do not vacuum an active user's database as an incidental test.
- Keep timeline/ingest cache invalidation consistent and database-heavy queries off the HTTP event loop where supported.

Deployment and backup operations: [DEPLOYMENT.md](docs/DEPLOYMENT.md), [BACKUP-DESIGN.md](docs/BACKUP-DESIGN.md). Private local operations are not part of this public repository.
