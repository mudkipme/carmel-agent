# MCP servers

Connect [Model Context Protocol](https://modelcontextprotocol.io) servers to give an agent new tools: an issue tracker, a database, a filesystem server, an internal API.

Carmel Agent supports two kinds of servers:

- **Remote HTTP** servers, reached over Streamable HTTP. Requires the agent's **Web access** permission.
- **Sandbox stdio** servers, started as a process inside the agent's runner container. Requires **Run commands**.

## Add a server

Open **Agent Settings → MCP**, add a server, then **Save**. Only the agent's owner can view or change MCP configuration. On a shared agent, everyone who can use it gets its MCP tools, acting with the owner's configured credentials.

Each server has:

- a unique **ID**,
- an enabled switch,
- a request timeout, and
- a tool allowlist. **Expose all tools** offers every tool the server provides. With it off, list the tool names to offer, one per line; an empty list offers none.

**Test connection** lists the server's tools without calling any of them or saving the configuration.

## Remote HTTP servers

Enter the server's Streamable HTTP endpoint, for example `https://example.com/mcp`. Both JSON and SSE responses are supported.

HTTP headers are a JSON object. Reference credentials as `${NAME}` instead of pasting them:

```json
{
  "Authorization": "Bearer ${MCP_TOKEN}"
}
```

Then add `MCP_TOKEN` in **Agent Settings → Environment → Secrets**. Secrets are resolved on the server and redacted from results, progress, and errors.

::: tip Keep credentials in Secrets
MCP settings are stored as JSON that the owner can read back. Environment secrets are write-only and encrypted with `CARMEL_SECRET_KEY`.
:::

Remote tools act with the remote service's permissions. Carmel Agent's file permissions only govern its own workspace tools, so use the server's own credentials and the tool allowlist to control what the agent can do there.

## Sandbox stdio servers

Stdio servers run inside the environment's runner container, with its workspace, mounts, home, secrets, and network policy. They never run on the host.

For example, the reference filesystem server:

- **Command:** `npx`
- **Arguments** (one per line): `-y`, `@modelcontextprotocol/server-filesystem`, `.`

The command must exist in the runner image, and `npx` downloads need the environment's **Sandbox network access**. Servers start in the agent's working folder.

Environment variables are a JSON object, and both variables and arguments may reference `${SECRET_NAME}`. Arguments are passed directly, not through a shell.

Closing the connection stops the server's process group, without affecting other commands or terminals in the container.

## When servers connect

Enabled servers connect when a run starts and disconnect when it ends, including scheduled runs. Tools are discovered fresh each run. If a server cannot connect, or an allowlisted tool is missing, the run fails to start with an error naming the server.

Tool names are namespaced per server and kept within the 64-character limit models impose. Text, images, structured output, progress, and errors pass through unchanged. Embedded text and JSON resources reach the model as text; other binary resources are omitted.

## Using MCP with Codemode

With [Codemode](/guide/codemode) enabled, scripts can call MCP tools alongside the agent's other tools, with the same connections, credentials, allowlists, and redaction. Each MCP server appears as its own namespace with the server's instructions.

## Not yet supported

- Browser-based OAuth login for MCP servers.
- MCP resources and prompts.
