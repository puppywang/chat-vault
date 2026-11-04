# Optional Chappie integration

ChatVault can correlate ChatGPT conversations with their Pi execution-side records. The optional upstream observer is installed with `scripts/install-chappie-upstream-observer.mjs`; inspect `--help` and the target Chappie version before applying it.

The archive, Web UI and read-only MCP tools do not require Chappie, a tunnel, Events or a particular deployment topology. Configure Pi and Chappie using their own documentation. Machine-specific tunnel configuration, credentials, browser traces and experiment receipts do not belong in this repository.

Local Pi process management and timestamp integrations are provided separately in `integrations/pi-services` and `integrations/pi-timestamps`.
