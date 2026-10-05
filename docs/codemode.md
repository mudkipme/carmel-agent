# Codemode

Open **Agent Settings → Codemode**, turn on **Enable codemode**, then **Save**. It is off by default and applies to the next run. MCP configuration is independent: codemode also works without any MCP servers.

Carmel uses Pi's public `@earendil-works/pi-codemode` SDK to run JavaScript in a QuickJS WebAssembly worker. The script receives the agent's final permitted tool list, including workspace, shell, network, MCP, and session-specific tools. Session tools can override existing tools; the same override is available to direct calls and scripts. Codemode does not expose itself. Direct tools remain available.

Scripts can combine independent calls with `Promise.all`, process results, and return a selected summary to the model:

```js
const paths = ["README.md", "package.json"];
const files = await Promise.all(paths.map(path => tools.read({ path })));
text(files.map((file, index) => ({
  path: paths[index],
  preview: file.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n")
    .slice(0, 500),
})));
```

Use the tool names and argument schemas from codemode's generated declarations. Check tool presence with `"read" in tools`; accessing an unknown member throws. Tools declaring an output schema return their `structuredContent` directly. Other tools return `{ content, structuredContent? }`; forward an image with `image("data:" + part.mimeType + ";base64," + part.data)`. Pi validates the image bytes and detects their MIME type. Tool failures throw inside the script and can be handled with `try/catch`. Tools marked sequential retain their execution ordering, and argument preparation and validation also apply to nested calls. Native edits take `{path, edits: [{oldText, newText}]}`.

Only explicit output (`text`, `console`, `image`) and the script's return value enter the model transcript. Nested calls appear with their status and duration in **Show work**, both during execution and after reloading the conversation. Their full results are not added to the transcript or nested-call history.

The sandbox has no direct filesystem, network, shell, imports, or access to agent secrets. External operations go through injected tools with their existing permissions, workspace boundaries, and MCP allowlists. Each script has a 60-second deadline, a 64 MiB VM memory limit, and a 250-call batch limit. Nested calls also count against the existing run-wide tool limit, including parallel calls. Text output uses Pi's standard 50 KiB / 2,000-line truncation. Each execution starts fresh; `store`/`load` values are not persisted between calls.

An optional first line, `// @options: {"max_output_tokens": 1000, "timeout_ms": 10000}`, can reduce the text output budget and deadline for an individual script. Carmel clamps these to its existing limits.

Stopping a run or timing out a script cancels pending calls. Finishing without awaiting a call also cancels that call. Cancellation cannot undo completed actions. Pi Durable records tool intent before effects and persists the result; an interrupted codemode execution is reported instead of automatically repeated during recovery. A deliberate new tool call can run the batch again. See [Pi Durable storage](pi-durable.md).

Migration `030_agent_codemode` preserves existing opt-ins: if any MCP server previously had **Allow codemode** enabled, the agent-level setting becomes enabled. The old per-server flags are removed, and scripts can now use all of that agent's permitted tools.
