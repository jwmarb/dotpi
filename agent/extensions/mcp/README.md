# pi-mcp

pi extension that connects to MCP (Model Context Protocol) servers and registers
their tools as native pi tools the LLM can call.

## Config

Read from `~/.pi/agent/mcp.json` (override with `PI_MCP_CONFIG`). Standard
`mcpServers` shape (Claude-Desktop-compatible), plus a bare top-level map:

```json
{
  "mcpServers": {
    "litellm-gateway": {
      "url": "https://your-litellm-gateway/mcp",
      "headers": { "Authorization": "Bearer ***" },
      "timeout": 15000
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
- `disabled: true` — skip the server

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
