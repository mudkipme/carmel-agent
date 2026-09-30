# MCP tools

Carmel uses `@earendil-works/pi-mcp` to connect MCP servers directly to its `AgentHarness` runtime. Pi handles protocol negotiation, tool discovery, requests, progress, cancellation, and content conversion. Carmel supplies per-agent configuration and the sandbox transport.

## Configure a server

Open **Agent Settings → MCP**, add a server, then **Save**. Only the agent's owner can view or change this configuration. A shared agent offers its configured MCP tools to everyone who can run it, using the owner's configured credentials.

Each server has a unique ID, an enabled switch, a request timeout, and an optional tool allowlist. **Expose all tools** offers every discovered tool. With it switched off, enter the original MCP tool names, one per line; an empty list offers no tools. **Test connection** lists the server's original tool names without invoking any tool or saving configuration.

Enabled servers connect at run startup and disconnect when the run finishes, fails, or is cancelled. Scheduled runs use the same path. Discovery is refreshed on each run. A failed connection or a missing allowlisted tool fails startup with a server-specific error.

### Remote HTTP

Use the server's Streamable HTTP endpoint, for example `https://example.com/mcp`. JSON and SSE responses are handled by Pi. Enable and save the agent's **network** permission before connecting.

HTTP headers are a JSON object:

```json
{
  "Authorization": "Bearer ${MCP_TOKEN}"
}
```

Create `MCP_TOKEN` in **Agent Settings → Secrets**. Secret references are resolved on the server and secret values are redacted from text results, progress, errors, and structured results. Store credentials in Secrets rather than as literal configuration values: MCP settings are owner-readable JSON, while agent secrets use the existing write-only storage and `CARMEL_SECRET_KEY` encryption setting.

Remote tools act with the remote service's permissions. Carmel's read, write, and edit switches govern its own workspace tools; they do not constrain a remote MCP service. Use the server's credentials and tool allowlist to choose what the agent can do there.

### Sandbox stdio

Enable and save **bash** permission. Stdio commands execute inside the existing per-agent runner container, with the agent's workspace, mounts, home, secrets, and network policy. They never execute as host processes.

For a filesystem server, configure:

- Command: `npx`
- Arguments, one per line: `-y`, `@modelcontextprotocol/server-filesystem`, `/workspace`

The command must be available inside the runner. `npx` downloads also require network permission. Default workspaces are mounted at `/workspace`; manually configured workspaces retain their absolute paths. Environment variables are a JSON object and may reference `${SECRET_NAME}`. Arguments may also use secret references; they are passed directly rather than interpreted by a shell.

The stdio server is supervised inside the runner. Closing the MCP connection closes stdin and terminates its process group, with a two-second forced termination fallback. It does not kill other commands or terminals sharing the agent's container.

## Harness behavior

Tools receive stable, namespaced names within the model's 64-character tool-name limit. Their original schemas, text/image results, failure flags, progress updates, and structured outputs pass through Pi's public interfaces. Structured outputs are also included in persisted tool details because the harness transcript stores tool details rather than a separate structured-content field.

This integration exposes MCP tools. Browser OAuth login, MCP resource/prompt interfaces, and codemode are not currently exposed in Carmel's UI.
