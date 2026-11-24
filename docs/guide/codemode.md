# Codemode

Codemode lets an agent write a short JavaScript program that calls its tools, instead of calling them one at a time. It is useful when a job involves many similar calls, combining results, or filtering large outputs before they reach the model — saving both time and context.

## Turn it on

Open **Agent Settings → Codemode**, turn on **Enable codemode**, and **Save**. It is off by default and applies from the next run. Codemode works with or without [MCP servers](/guide/mcp).

The agent keeps its direct tools too; it chooses when a script is the better fit.

## What scripts can do

A script receives every tool the agent is permitted to use in that run — file, shell, web, MCP, and session tools — as `tools.<name>()`. Calls are asynchronous, so independent calls can run in parallel:

```js
const paths = ["README.md", "package.json"];
const files = await Promise.all(paths.map((path) => tools.read({ path })));
text(
  files.map((file, index) => ({
    path: paths[index],
    preview: file.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .slice(0, 500),
  })),
);
```

- Only explicit output — `text()`, `console`, `image()` — and the script's return value reach the model.
- Tool failures throw inside the script and can be caught with `try`/`catch`.
- `"read" in tools` checks whether a tool is available; `searchTools()` and `describeTool()` discover them.
- Tools with an output schema return their structured value directly. Others return `{ content, structuredContent? }`.

Nested calls appear with their status and duration under **Show work**, both live and after reload. Their full results are not added to the transcript.

## Limits

Scripts run in a QuickJS WebAssembly sandbox with no direct filesystem, network, shell, imports, or access to secrets. Everything external goes through the injected tools, with the agent's normal permissions, workspace boundaries, and MCP allowlists.

| Limit                 | Value                                     |
| --------------------- | ----------------------------------------- |
| Deadline              | 60 seconds                                |
| Memory                | 64 MiB                                    |
| Tool calls per script | 250 (also counted toward the run's limit) |
| Text output           | 50 KiB / 2,000 lines                      |

A script can lower its own output budget and deadline with an optional first line:

```js
// @options: {"max_output_tokens": 1000, "timeout_ms": 10000}
```

Options can lower Carmel Agent's limits but never raise them.

## Stopping and recovery

Stopping a run or hitting the deadline cancels pending calls, as does finishing without awaiting a call. Cancellation cannot undo actions that already completed.

If the server is interrupted while a script runs, completed calls are reused and the script is not blindly repeated: calls that might have had external effects are reported as interrupted. See [Session storage](/development/session-storage#durable-codemode) for details.
