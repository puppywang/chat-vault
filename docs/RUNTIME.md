# Optional agent runtime controls

Archive browsing and MCP queries are read-only. The Web UI can additionally start a user-requested continuation through a locally installed Claude Code, Codex or Copilot CLI. These actions execute work with the selected agent's permissions.

Runtime APIs are loopback-only, including output and approvals:

```text
POST /api/runs                 { session_id, agent, mode, input, model?, effort? }
GET  /api/runs/:id
GET  /api/runs/:id/events       SSE, ?after=seq
POST /api/runs/:id/cancel
GET/POST /api/runs/:id/approvals[/approvalId]
GET  /api/runtime/capabilities
GET  /api/runtime/models?agent=codex
GET  /api/runtime/status
GET  /healthz
```

Use `CHATVAULT_CODEX_BIN`, `CHATVAULT_CLAUDE_BIN` or `CHATVAULT_COPILOT_BIN` to override a CLI executable. Codex model choices are read from the installed app-server and current account rather than hardcoded.

`input` accepts a string or compatible structured input. Attachments must be approved base64 data URLs; arbitrary remote attachment URLs are not fetched. The UI limits raw attachments to 35 MB and total encoded input to 48 MB. Unsupported media types are rejected rather than silently dropped.

A Codex Resume requires the original thread's native write access. An active writer conflict is reported; it is never silently changed into Fork. Close the original writer or explicitly choose Fork.

One-shot Claude runtime calls use a strict empty MCP configuration to avoid leaving unrelated MCP child processes. Use an ordinary Claude Code session for workflows requiring its configured MCP tools.
