import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agentMcpServerSchema, codemodeCallsSchema, type AgentMcpServer } from "@carmel-agent/shared";
import { BACKGROUND_CONTEXT, withAbortSignal, type AgentHarnessTool, type AgentHarnessToolInvocation, type ExecutionToolContext } from "../effectors/pi-durable/index.ts";
import { createModels } from "@earendil-works/pi-ai";
import { toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { db, migrate } from "../db/index.ts";
import { agents } from "../db/schema.ts";
import { createSession } from "../test-support.ts";
import { startMcpTestServer } from "../test-mcp-server.ts";
import { openTestHarness } from "../effectors/testing/pi-harness.ts";
import { RunGuard, RunGuardError } from "../effectors/run-guard.ts";
import { AgentMcpTools } from "./mcp-tools.ts";
import { createCodemodeTool, type CodemodeHooks } from "./codemode-tool.ts";
import { createServerExecution } from "./tools.ts";
import { projectRunEvent } from "./run-events.ts";

migrate();
type Tool = AgentHarnessTool<ExecutionToolContext>;
const serverConfig = (url: string, patch = {}) => agentMcpServerSchema.parse({ id: "remote", transport: "http", url, ...patch });
function agent(servers: AgentMcpServer[]) {
  const { agentId } = createSession();
  return { ...db.select().from(agents).where(eq(agents.id, agentId)).get()!, codemodeEnabled: true, mcpServers: servers, permissions: { read: false, write: false, edit: false, bash: false, network: true } };
}
function invocation(): AgentHarnessToolInvocation {
  return { invocationId: "invocation", operationId: "operation", turnId: "turn" };
}

function execute(tools: AgentMcpTools | readonly Tool[], code: string, options: { hooks?: CodemodeHooks; signal?: AbortSignal; memo?: AgentHarnessToolInvocation; toolContext?: ExecutionToolContext } = {}) {
  return createCodemodeTool(tools instanceof AgentMcpTools ? tools.tools : tools, options.hooks).execute(
    "codemode-call", { code }, () => {}, options.toolContext ?? {} as never, options.memo ?? invocation(),
    options.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
  );
}
function calls(result: { details?: unknown }) {
  return codemodeCallsSchema.parse((result.details as { codemodeCalls: unknown }).codemodeCalls);
}

test("codemode is an agent-level opt-in that works without MCP and obeys MCP permissions and allowlists", async () => {
  const remote = await startMcpTestServer();
  const disabled = createServerExecution({ ...agent([]), codemodeEnabled: false });
  try {
    await disabled.prepare();
    assert.equal(disabled.resolveTools().some((tool) => tool.name === "codemode"), false);
  } finally { await disabled.cleanup(BACKGROUND_CONTEXT); }
  for (const patch of [{ tools: [] }, { enabled: false }]) {
    const execution = createServerExecution(agent([serverConfig(remote.url, patch)]));
    try {
      await execution.prepare();
      const tools = execution.resolveTools();
      assert.equal(tools.some((tool) => tool.name === "codemode"), true);
      assert.equal(tools.some((tool) => tool.name.startsWith("mcp_")), false);
    } finally { await execution.cleanup(BACKGROUND_CONTEXT); }
  }
  const denied = agent([serverConfig(remote.url)]);
  denied.permissions.network = false;
  const execution = createServerExecution(denied);
  try {
    await execution.prepare();
    assert.deepEqual(execution.resolveTools().map((tool) => tool.name), ["codemode"]);
    const result = await execute(execution.resolveTools(), "text(6 * 7); text(ALL_TOOLS.length);");
    assert.deepEqual(result.content, [{ type: "text", text: "42\n0" }]);
  }
  finally { await execution.cleanup(BACKGROUND_CONTEXT); await remote.close(); }
  assert.equal(agentMcpServerSchema.safeParse({ id: "old", transport: "http", url: "https://example.com", codemode: true }).success, false);
});

test("AgentHarness persists one codemode result with nested call history and streams compact progress", async () => {
  const remote = await startMcpTestServer({
    tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, outputSchema: { type: "object", properties: { echo: { type: "boolean" } } } }],
  });
  const execution = createServerExecution(agent([serverConfig(remote.url, { id: "remote-with-dash", tools: ["echo"] })]));
  try {
    await execution.prepare();
    const tools = execution.resolveTools();
    const name = toCodemodeIdentifier(tools.find((tool) => tool.name.startsWith("mcp_"))!.name);
    const code = `const results = await Promise.all([tools.${name}({text:"one"}), tools.${name}({text:"two"})]); text(results.filter(r => r.echo).length);`;
    const { sessionId } = createSession();
    const faux = fauxProvider({ provider: `faux-codemode-${crypto.randomUUID()}`, tokensPerSecond: 100_000 });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([() => fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }), () => fauxAssistantMessage([fauxText("Done")])] as never);
    const pi = await openTestHarness(sessionId, { models, model: faux.getModel(), tools, toolContext: execution.toolContext });
    const updates: unknown[] = [];
    pi.observe((event) => { const projected = projectRunEvent(event); if (projected?.type === "tool_execution_update") updates.push(projected); });
    try {
      await pi.lane.prompt("Combine the MCP results", undefined, pi.context);
      const results = (await pi.branch()).flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
      assert.equal(results.length, 1, "nested outputs must not become LLM transcript messages");
      assert.deepEqual(results[0]?.content, [{ type: "text", text: "2" }]);
      assert.deepEqual(calls(results[0]!).map((call) => call.status), ["ok", "ok"]);
      assert.ok(updates.length >= 1, "Durable batches committed progress updates");
      assert.equal(JSON.stringify(updates).includes("echoed"), false);
      assert.equal(remote.requests.filter((request) => request.message?.method === "tools/call").length, 2);
    } finally { await pi.close(); }
  } finally { await execution.cleanup(BACKGROUND_CONTEXT); await remote.close(); }
});

test("codemode uses permitted native workspace tools and keeps their path boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-codemode-files-"));
  const row = { ...agent([]), workingDir: root, workingDirMode: "manual" as const, permissions: { read: true, write: true, edit: true, bash: false, network: false } };
  const execution = createServerExecution(row);
  try {
    await execution.prepare();
    const tools = execution.resolveTools();
    const result = await execute(tools, `
      await tools.write({path:"report.txt", content:"before"});
      await tools.edit({path:"report.txt", edits:[{oldText:"before", newText:"after"}]});
      const file = await tools.read({path:"report.txt"});
      text(file.content);
      text(["bash" in tools, "fetch_url" in tools, "codemode" in tools]);
    `, { toolContext: execution.toolContext });
    assert.equal(result.isError, false);
    assert.equal(readFileSync(join(root, "report.txt"), "utf8"), "after");
    assert.deepEqual(calls(result).map((call) => call.name), ["write", "edit", "read"]);
    assert.match(JSON.stringify(result.content), /after/);
    assert.match(JSON.stringify(result.content), /false/);
    const denied = await execute(tools, 'await tools.read({path:"../outside.txt"});', { toolContext: execution.toolContext });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /outside the agent working directory/);
  } finally { await execution.cleanup(BACKGROUND_CONTEXT); rmSync(root, { recursive: true, force: true }); }
});

test("codemode combines MCP, native files, and session tools after session overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-codemode-mixed-"));
  const remote = await startMcpTestServer();
  const execution = createServerExecution({ ...agent([serverConfig(remote.url, { tools: ["echo"] })]), workingDir: root, workingDirMode: "manual", permissions: { read: true, write: true, edit: false, bash: false, network: true } });
  const override: Tool = {
    name: "read", label: "Session read", description: "Session-specific read override",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    async execute(_id, { key }) { return { content: [{ type: "text", text: `session:${key}` }], details: undefined }; },
  };
  const report: Tool = {
    name: "report_issue", label: "Report issue", description: "A session-specific tool",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: [{ type: "text", text: "reported" }], details: undefined }; },
  };
  try {
    await execution.prepare();
    const tools = execution.resolveTools([override, report, createCodemodeTool([])]);
    assert.equal(tools.filter((tool) => tool.name === "read").length, 1);
    assert.equal(tools.filter((tool) => tool.name === "codemode").length, 1);
    const name = tools.find((tool) => tool.name.startsWith("mcp_"))!.name;
    const result = await execute(tools, `
      const remote = await tools.${name}({text:"hello"});
      const local = await tools.read({key:"brief"});
      await tools.write({path:"report.json", content:JSON.stringify({remote:remote.structuredContent, local:local.content[0].text})});
      text((await tools.report_issue({})).content);
      text("codemode" in tools);
    `, { toolContext: execution.toolContext });
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "report.json"), "utf8")), { remote: { echo: true }, local: "session:brief" });
    assert.deepEqual(calls(result).map((call) => call.name), [name, "read", "write", "report_issue"]);
    assert.match(JSON.stringify(result.content), /reported/);
    assert.match(JSON.stringify(result.content), /false/);
  } finally { await execution.cleanup(BACKGROUND_CONTEXT); await remote.close(); rmSync(root, { recursive: true, force: true }); }
});

test("nested tools retain argument preparation, sequential scheduling, and termination hints", async () => {
  const order: string[] = [];
  const makeTool = (name: string, executionMode: "parallel" | "sequential", terminate = false): Tool => ({
    name, label: name, description: name, executionMode,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    prepareArguments: (args) => ({ text: (args as { legacy: string }).legacy }),
    async execute(_id, { text }) {
      order.push(`${text}:start`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      order.push(`${text}:end`);
      return { content: [{ type: "text", text }], details: undefined, ...(terminate ? { terminate: true } : {}) };
    },
  });
  const result = await execute([makeTool("parallel", "parallel"), makeTool("serial", "sequential")], `await Promise.all([
    tools.parallel({legacy:"first"}), tools.serial({legacy:"middle"}), tools.parallel({legacy:"last"})
  ]);`);
  assert.equal(result.isError, false);
  assert.deepEqual(order, ["first:start", "first:end", "middle:start", "middle:end", "last:start", "last:end"]);
  const ended = await execute([makeTool("finish", "sequential", true)], 'await tools.finish({legacy:"done"});');
  assert.equal(ended.terminate, true);
});

test("script failures keep their error flag and call details in the durable harness transcript", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({ provider: `faux-codemode-error-${crypto.randomUUID()}`, tokensPerSecond: 100_000 });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([() => fauxAssistantMessage([fauxToolCall("codemode", { code: 'throw new Error("script failed");' })], { stopReason: "toolUse" }), () => fauxAssistantMessage([fauxText("Handled")])] as never);
  const pi = await openTestHarness(sessionId, { models, model: faux.getModel(), tools: [createCodemodeTool([])] });
  try {
    await pi.lane.prompt("Run the failing script", undefined, pi.context);
    const result = (await pi.branch()).flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [])[0]!;
    assert.equal(result.isError, true);
    assert.deepEqual(calls(result), []);
    assert.match(JSON.stringify(result.content), /script failed/);
  } finally { await pi.close(); }
});

test("nested arguments are validated before MCP execution and denied tools stay unavailable", async () => {
  const remote = await startMcpTestServer();
  const mcp = new AgentMcpTools(agent([serverConfig(remote.url)]), "/tmp/test");
  try {
    await mcp.connect({ secrets: [] });
    const name = mcp.tools[0]!.name;
    const result = await execute(mcp, `await tools.${name}({});`);
    assert.equal(result.isError, true);
    assert.equal(calls(result)[0]?.status, "error");
    assert.equal(remote.requests.some((request) => request.message?.method === "tools/call"), false);
    const unavailable = await execute(mcp, 'text([typeof process, typeof fetch, typeof require, "bash" in tools]);');
    assert.deepEqual(unavailable.content, [{ type: "text", text: '["undefined","undefined","undefined",false]' }]);
  } finally { await mcp.close(); await remote.close(); }
});

test("failed nested tools throw into the script and redact credentials", async () => {
  const secret = "codemode-private-token";
  const remote = await startMcpTestServer({ onCall() { return { content: [{ type: "text", text: secret }], isError: true }; } });
  const mcp = new AgentMcpTools(agent([serverConfig(remote.url)]), "/tmp/test");
  try {
    await mcp.connect({ secrets: [{ name: "TOKEN", value: secret }] });
    const result = await execute(mcp, `try { await tools.${mcp.tools[0]!.name}({text:"fail"}); } catch (e) { text(e.message); }`);
    assert.equal(result.isError, false, "the script can handle a tool failure");
    assert.equal(calls(result)[0]?.status, "error");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.match(JSON.stringify(result.content), /redacted:TOKEN/);
  } finally { await mcp.close(); await remote.close(); }
});

test("abort and unawaited calls cancel MCP requests and retain the nested history", async () => {
  for (const unawaited of [false, true]) {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let cancelled!: () => void;
    const notified = new Promise<void>((resolve) => { cancelled = resolve; });
    const remote = await startMcpTestServer({ onCall() { started(); return undefined; }, onNotification(message) { if (message.method === "notifications/cancelled") cancelled(); } });
    const mcp = new AgentMcpTools(agent([serverConfig(remote.url)]), "/tmp/test");
    try {
      await mcp.connect({ secrets: [] });
      const controller = new AbortController();
      const code = `${unawaited ? "" : "await "}tools.${mcp.tools[0]!.name}({text:"wait"});${unawaited ? "return;" : ""}`;
      const pending = execute(mcp, code, { signal: controller.signal });
      if (!unawaited) { await ready; controller.abort(); }
      const result = await pending;
      assert.equal(result.isError, !unawaited);
      assert.equal(calls(result)[0]?.status, "cancelled");
      // An unawaited call may be cancelled before its HTTP request is admitted.
      if (!unawaited) await notified;
    } finally { await mcp.close(); await remote.close(); }
  }
});

test("parallel nested calls cannot bypass the run guard or local batch limit", async () => {
  const remote = await startMcpTestServer();
  const mcp = new AgentMcpTools(agent([serverConfig(remote.url)]), "/tmp/test");
  try {
    await mcp.connect({ secrets: [] });
    const guard = new RunGuard({ maxToolCalls: 2, stallTimeoutMs: 60_000 });
    const controller = new AbortController();
    const result = await execute(mcp, `await Promise.all(Array.from({length:20}, () => tools.${mcp.tools[0]!.name}({text:"batch"})));`, {
      hooks: { signal: controller.signal, beforeCall() { const stop = guard.recordToolCall(); if (stop) { controller.abort(); throw new RunGuardError(stop); } } },
    });
    assert.equal(guard.stop?.reason, "tool_ceiling");
    assert.equal(guard.toolCalls, 3);
    assert.equal(result.isError, true);
    assert.ok(remote.requests.filter((request) => request.message?.method === "tools/call").length <= 2);
    const limited = await execute(mcp, `await Promise.all(Array.from({length:20}, () => tools.${mcp.tools[0]!.name}({text:"batch"})));`, { hooks: { maxCalls: 2 } });
    assert.equal(limited.isError, true);
    assert.ok(calls(limited).length <= 2);
  } finally { await mcp.close(); await remote.close(); }
});

test("codemode deadlines stop spinning scripts", async () => {
  const remote = await startMcpTestServer();
  const mcp = new AgentMcpTools(agent([serverConfig(remote.url)]), "/tmp/test");
  try {
    await mcp.connect({ secrets: [] });
    const timed = await execute(mcp, "while (true) {}", { hooks: { timeoutMs: 100 } });
    assert.equal(timed.isError, true);
    assert.match(JSON.stringify(timed.content), /timed out/);

  } finally { await mcp.close(); await remote.close(); }
});

test("Pi source options can lower output and deadline limits without raising Carmel's limits", async () => {
  const short = await execute([], '// @options: {"max_output_tokens": 10}\ntext("x".repeat(1000));');
  assert.equal(short.isError, false);
  assert.ok(JSON.stringify(short.content).length < 150);
  assert.match(JSON.stringify(short.content), /Output truncated/);
  const timed = await execute([], '// @options: {"timeout_ms": 5000}\nwhile (true) {}', { hooks: { timeoutMs: 50 } });
  assert.equal(timed.isError, true);
  assert.match(JSON.stringify(timed.content), /timed out/);
  await assert.rejects(execute([], '// @options: {"timeout_ms": 0}\ntext("no");'), /timeout_ms/);
});

test("codemode forwards explicitly selected MCP images and truncates oversized script output", async () => {
  const remote = await startMcpTestServer({ onCall() { return { content: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==", mimeType: "image/png" }] }; } });
  const mcp = new AgentMcpTools(agent([serverConfig(remote.url)]), "/tmp/test");
  try {
    await mcp.connect({ secrets: [] });
    const result = await execute(mcp, `const img = (await tools.${mcp.tools[0]!.name}({text:"image"})).content[0]; image("data:" + img.mimeType + ";base64," + img.data); text("large".repeat(30_000));`);
    assert.equal(result.isError, false);
    assert.ok(JSON.stringify(result.content).length < 55_000);
    assert.ok(result.content.some((part) => part.type === "image" && part.data === "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=="));
    assert.match(JSON.stringify(result.content), /Output truncated/);
  } finally { await mcp.close(); await remote.close(); }
});
