# pi-mcp

pi extension that connects to MCP (Model Context Protocol) servers and registers
their tools as native pi tools the LLM can call.

## Setup

The extension's npm dependencies live in a gitignored `node_modules/`, so a
fresh clone of the repo has the source without them — the load failure is
`Cannot find module '@modelcontextprotocol/sdk/...'`. `scripts/setup-deps.sh`
installs them, and it runs automatically: at pi startup (covers the initial
clone, which no git hook sees) and on checkout/merge (tracked git hooks).
A clone that still fails loads them with `bash scripts/setup-deps.sh`.
## Config

Read from `~/.pi/agent/mcp.json` (override with `PI_MCP_CONFIG`). Standard
`mcpServers` shape (Claude-Desktop-compatible), plus a bare top-level map:

```json
{
  "mcpServers": {
    "litellm-gateway": {
      "url": "${LITELLM_MCP_URL}",
      "headers": { "x-litellm-api-key": "Bearer ${LITELLM_MCP_KEY}" },
      "timeout": 15000
    },
    "robinhood": {
      "url": "https://agent.robinhood.com/mcp/trading",
      "auth": "oauth"
    },
    "local-fs": {
      "command": "node",
      "args": ["/path/to/server.mjs"],
      "env": { "FOO": "bar" }
    }
  }
}
```

Per server:

- `url` + `headers` — Streamable HTTP transport
- `command` (+ `args`, `env`) — stdio transport (spawns a child process)
- `timeout` — connect timeout in ms (default 15000)
- `auth: "oauth"` — HTTP servers that require OAuth (see below)
- `authPort` — fixed local port for the OAuth callback (default: any free port)
- `disabled: true` — skip the server

Any string field (`url`, `headers`, `args`, `env`) supports `${VAR}` placeholders,
expanded from the process environment or `agent/.env`. An unset variable fails
loudly at config load with the exact field named; escape a literal `${` as `$${`.

## OAuth

`"auth": "oauth"` on an HTTP server enables the authorization-code + PKCE flow
with dynamic client registration (RFC 7591). On first connect the server's
401 triggers discovery (RFC 9728/8414), the extension registers a client,
opens your browser at the authorization URL, and listens on a local
`127.0.0.1` port for the redirect. The widget shows
`awaiting browser auth…` while you complete it; on a headless machine the URL
is printed to the console so you can finish it on any device.

Client registration, tokens, and the PKCE verifier persist in
`~/.pi/agent/mcp-auth/<server>.json` (mode 0600), so you authorize once and
restarts reuse the saved tokens. `/mcp refresh <server>` re-runs the flow;
deleting the state file forces a fresh authorization.
## Tools

Each MCP tool becomes a pi tool named `mcp__<server>__<tool>` (sanitized,
truncated to 64 chars). Image results are passed to the model as images;
`isError` results surface as failed tool calls.

## Commands

- `/mcp` — status of all servers
- `/mcp status` — same
- `/mcp list [server]` — list tools (all or one server)
- `/mcp refresh [server]` — reconnect a server (or all) and re-register tools

A status widget appears above the editor while any MCP server is configured.
Servers that fail to connect at startup don't block pi — check `/mcp status`
and use `/mcp refresh <server>` to retry.
