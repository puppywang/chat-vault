# AGENTS.md — ChatVault

> This file is the agent-facing guide for this repo. Human overview lives in `README.md`.

## What this repo is

ChatVault syncs conversations from 13 agents (Claude Code / Codex / Copilot / Cursor / Antigravity / Windsurf / Kiro / etc.) into a local SQLite DB (`~/.agent-exporter/agent-exporter.db`) and serves a Web UI + MCP endpoint for shared memory across agents.

- Runtime: Node.js ≥ 22.5, `node:sqlite` + FTS5, no `npm install` required
- Data is read-only — do not write back to agent source directories
- Default endpoint: `http://127.0.0.1:8377` (use `127.0.0.1`, not `localhost`)

## Quick start (for agents)

```bash
node src/cli.js sync              # one-off sync (incremental, fingerprint-based)
node src/cli.js serve --port 8377 # start Web UI + watcher + MCP (http://127.0.0.1:8377/mcp)
node src/cli.js search "入水检测"  # CLI search
node src/cli.js stats             # totals
```

Daily use: keep `serve` running. It watches agent data dirs and syncs incrementally (debounce + cooldown).

## MCP

All agents use the same HTTP MCP endpoint (requires `serve` running):

```jsonc
{ "mcpServers": { "chatvault": { "type": "http", "url": "http://127.0.0.1:8377/mcp" } } }
```

Tools: `search_conversations`, `get_session`, `list_sessions`, `get_session_chain` (supports `direction: downstream | upstream | both`), `list_task_states`, `list_flagged`, `list_workspaces`, `get_stats`.

Typical handoff: `请用 chat-vault 读取 1623 对话，然后继续完成剩余工作` → next agent calls `get_session_chain(1623)`.

## Project layout

```
src/adapters/   one parser per agent → unified session model
src/sync.js     discover → fingerprint → parse → upsert
src/db.js       SQLite schema + FTS5 + migrations
src/query.js    sessions/search/workspaces/stats/chain queries
src/links.js    session chain extraction (strong patterns + kind grading)
src/server.js   HTTP API + SSE + static UI + /mcp
src/mcp-tools.js shared MCP tool definitions + exec
src/cli.js      CLI entry
ui/             vanilla JS SPA (no build)
docs/AGENT-INTEGRATION-GUIDE.md  5-step guide for adding a new agent
```

New agent: follow `docs/AGENT-INTEGRATION-GUIDE.md`.

## Conventions

- Do not edit `~/.agent-exporter/agent-exporter.db` directly in tests; use temp copy via `openDb(tmpPath)`.
- Do not commit `API_KEY.txt` or `~/.agent-exporter/config.json` secrets.
- Prefer `127.0.0.1` over `localhost` (avoids IPv6 fallback issues).
- `node:sqlite` on Node 22.x needs `--experimental-sqlite` — entry handles auto-restart.
- Keep `src/adapters/<agent>.js` self-contained; add `afterSync` only when needed (e.g. Kiro log backfill).

## Checks before PR

```bash
node --check src/*.js
node src/cli.js sync --full 2>&1 | tail
```

If you change adapters, run a full sync and verify `stats` + `GET /api/stats` unchanged for unrelated agents.
