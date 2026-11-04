# ChatVault v0.5.0

ChatVault is a local conversation archive for both people and AI agents. People browse and search through the Web UI; agents query the same records through read-only HTTP MCP.

## Highlights

- Rewritten quick start, deployment and backup/restore guides with portable examples.
- New source adapters and fixes for conversation titles, workspaces and Codex review records.
- Sync/backup status in the UI, consistent data snapshots, optional encrypted restic backups and restore verification.
- ChatGPT Sync browser extension with conversation association, Pi session controls and concise connection text. Browser debugging/capture belongs in a separate browser tool.
- Public distribution excludes personal experiment reports, machine-specific deployment records, source archives, credentials and development dependencies.

## Install

```sh
npm install -g https://github.com/puppywang/chat-vault/releases/latest/download/chat-vault.tgz
chat-vault serve --port 8377
```

Requires Node.js 22.19 or newer. Open http://127.0.0.1:8377. Optional MCP endpoint: http://127.0.0.1:8377/mcp.

For ChatGPT web imports, download `chatgpt-sync.zip`, extract it and load the directory as an unpacked Chrome extension. The source archive includes the same extension under `extensions/chatgpt-sync/`.

## Validation

- Node test suite: 398 passed, 1 skipped.
- Three isolated headless-browser scenarios passed.
- 96 application/integration JavaScript syntax checks passed.
- Packaged CLI, UI, health, stats and MCP catalog passed in a separate data directory.
- Public source and distribution allowlists checked for private records and credentials.

Back up your existing data directory before upgrading. No personal archives or runtime configuration are included in this release.
