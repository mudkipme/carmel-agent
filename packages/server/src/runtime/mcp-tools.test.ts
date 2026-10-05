import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { agentMcpServerSchema, agentMcpServersSchema, type AgentMcpServer } from "@carmel-agent/shared";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { db, initialize } from "../db/index.ts";
import { agents } from "../db/schema.ts";
import { createSession } from "../test-support.ts";
import { startMcpTestServer } from "../test-mcp-server.ts";
import { openTestHarness } from "../effectors/testing/pi-harness.ts";
import { AgentMcpTools, expandMcpSecrets, mcpToolName } from "./mcp-tools.ts";
import { createServerExecution } from "./tools.ts";
import { HarnessAbortGate } from "./agent-runtime.ts";

initialize();
function agent(servers: AgentMcpServer[], permissions = { read: false, write: false, edit: false, bash: true, network: true }) {
  const fixture = createSession();
  const row = db.select().from(agents).where(eq(agents.id, fixture.agentId)).get()!;
  return { ...row, mcpServers: servers, permissions };
}
const http = (url: string, patch: Partial<AgentMcpServer> = {}) => agentMcpServerSchema.parse({ id: "remote", transport: "http", url, ...patch });

test("MCP configuration validates transports, IDs, timeouts, and unique server IDs", () => {
  assert.equal(agentMcpServerSchema.safeParse({ id: "a", transport: "http", url: "file:///tmp" }).success, false);
  assert.equal(agentMcpServerSchema.safeParse({ id: "a", transport: "http", url: "https://user:pass@example.com" }).success, false);
  assert.equal(agentMcpServerSchema.safeParse({ id: "bad/name", transport: "stdio", command: "npx" }).success, false);
  assert.equal(agentMcpServerSchema.safeParse({ id: "ok", transport: "stdio", command: "npx", timeoutMs: 0 }).success, false);
  assert.equal(agentMcpServersSchema.safeParse([http("https://example.com"), http("https://example.org")]).success, false);
  assert.throws(() => expandMcpSecrets("Bearer ${MISSING}", []), /Missing agent secret/);
  assert.equal(expandMcpSecrets("Bearer ${TOKEN}", [{ name: "TOKEN", value: "abc" }]), "Bearer abc");
});

test("MCP tool names are stable, provider-safe, and distinct after sanitization and truncation", () => {
  const values = [mcpToolName("server", "read/path"), mcpToolName("server", "read.path"), mcpToolName("other", "read/path"), mcpToolName("server", "x".repeat(200))];
  assert.equal(new Set(values).size, 4);
  assert.ok(values.every((name) => name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name)));
  assert.equal(values[0], mcpToolName("server", "read/path"));
});

test("disabled, denied, and empty-allowlist servers never open a transport", async () => {
  const denied = agent([http("https://unused.test"), agentMcpServerSchema.parse({ id: "local", transport: "stdio", command: "npx" })], { read: false, write: false, edit: false, bash: false, network: false });
  const mcp = new AgentMcpTools(denied, "/tmp/test");
  await mcp.connect({ secrets: [], createTransport: () => { throw new Error("must not connect"); } });
  assert.deepEqual(mcp.tools, []);
  await mcp.close();
  const skipped = new AgentMcpTools(agent([http("https://unused.test", { enabled: false }), http("https://unused.test", { id: "empty", tools: [] })]), "/tmp/test");
  await skipped.connect({ secrets: [], createTransport: () => { throw new Error("must not connect"); } });
  await skipped.close();
});

test("HTTP MCP tools run inside AgentHarness and persist results through the SQLite session", async () => {
  const remote = await startMcpTestServer();
  const row = agent([http(remote.url, { headers: { Authorization: "Bearer ${TOKEN}" } })]);
  const mcp = new AgentMcpTools(row, "/tmp/test");
  try {
    await mcp.connect({ secrets: [{ name: "TOKEN", value: "private-credential" }] });
    const { sessionId } = createSession();
    const faux = fauxProvider({ provider: `faux-mcp-${crypto.randomUUID()}`, tokensPerSecond: 100_000 });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall(mcp.tools[0]!.name, { text: "hello" })], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxText("Done")]),
    ] as never);
    const pi = await openTestHarness(sessionId, { models, model: faux.getModel(), tools: mcp.tools });
    try {
      await pi.lane.prompt("Use the MCP echo tool", undefined, pi.context);
      const results = (await pi.branch()).flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
      assert.equal(results.length, 1);
      assert.deepEqual(results[0]?.content, [{ type: "text", text: "echoed" }]);
      assert.deepEqual(results[0]?.details, { serverId: "remote", toolName: "echo", structuredContent: { echo: true } });
      assert.equal(results[0]?.isError, false);
      const call = remote.requests.find((request) => request.message?.method === "tools/call");
      assert.deepEqual(call?.message?.params && (call.message.params as { arguments: unknown }).arguments, { text: "hello" });
      assert.equal(call?.authorization, "Bearer private-credential");
    } finally { await pi.close(); }
    await mcp.close(); await mcp.close();
    assert.equal(remote.requests.filter((request) => request.method === "DELETE").length, 1);
  } finally { await mcp.close(); await remote.close(); }
});

test("MCP progress, structured content, and tool failure flags survive the adapter without leaking secrets", async () => {
  const secret = "super-private-token";
  const remote = await startMcpTestServer({ onCall(message, response) {
    const token = (message.params as { _meta: { progressToken: unknown } })._meta.progressToken;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2, message: secret } })}\n\n`);
    response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `Failure: ${secret}` }], structuredContent: { token: secret }, isError: true } })}\n\n`);
    return undefined;
  } });
  const mcp = new AgentMcpTools(agent([http(remote.url)]), "/tmp/test");
  try {
    await mcp.connect({ secrets: [{ name: "TOKEN", value: secret }] });
    const updates: unknown[] = [];
    const result = await mcp.tools[0]!.execute("call", { text: "hello" }, (update) => updates.push(update), {} as never, {} as never, {} as never);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { token: "[redacted:TOKEN]" });
    assert.equal(updates.length, 1);
    assert.equal(JSON.stringify([result, updates]).includes(secret), false);
  } finally { await mcp.close(); await remote.close(); }
});

test("MCP cancellation reaches Pi and server request notifications", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let cancelled!: () => void;
  const notified = new Promise<void>((resolve) => { cancelled = resolve; });
  const remote = await startMcpTestServer({
    onCall() { started(); return undefined; },
    onNotification(message) { if (message.method === "notifications/cancelled") cancelled(); },
  });
  const mcp = new AgentMcpTools(agent([http(remote.url)]), "/tmp/test");
  try {
    await mcp.connect({ secrets: [] });
    const controller = new AbortController();
    const pending = mcp.tools[0]!.execute("call", {}, () => {}, {} as never, {} as never, { abortSignal: controller.signal } as never);
    const rejected = assert.rejects(pending, /abort/i);
    await ready; controller.abort(); await rejected;
    await notified;
    await mcp.close();
    assert.ok(remote.requests.some((request) => request.message?.method === "notifications/cancelled"));
  } finally { await mcp.close(); await remote.close(); }
});

test("missing allowed tools fail setup and release already connected servers", async () => {
  const remote = await startMcpTestServer();
  const mcp = new AgentMcpTools(agent([http(remote.url, { id: "first" }), http(remote.url, { id: "second", tools: ["missing"] })]), "/tmp/test");
  try {
    await assert.rejects(mcp.connect({ secrets: [] }), /unavailable/);
    assert.equal(remote.requests.filter((request) => request.method === "DELETE").length, 2);
  } finally { await mcp.close(); await remote.close(); }
});

test("stopping a run during MCP transport startup returns promptly", async () => {
  const gate = new HarnessAbortGate();
  let starting!: () => void;
  const started = new Promise<void>((resolve) => { starting = resolve; });
  const mcp = new AgentMcpTools(agent([http("https://unused.test")]), "/tmp/test");
  let closed = false;
  const pending = mcp.connect({ secrets: [], signal: gate.signal, createTransport: () => ({
    start: async () => { starting(); await new Promise(() => {}); }, send: async () => {},
    close: async () => { closed = true; }, onMessage: () => () => {}, onError: () => () => {}, onClose: () => () => {},
  }) });
  const rejected = assert.rejects(pending, /abort/i);
  await started; gate.request(); await rejected;
  assert.equal(closed, true); await mcp.close();
});

test("the server execution lifecycle connects MCP tools and closes them during cleanup", async () => {
  const remote = await startMcpTestServer();
  const execution = createServerExecution(agent([http(remote.url)]));
  try {
    await execution.prepare();
    assert.ok(execution.tools.some((tool) => tool.name === mcpToolName("remote", "echo")));
    await execution.cleanup({} as never);
    assert.equal(remote.requests.filter((request) => request.method === "DELETE").length, 1);
  } finally { await execution.cleanup({} as never); await remote.close(); }
});

test("an allowlist exposes only selected tools and preserves structured and image results", async () => {
  const remote = await startMcpTestServer({
    tools: ["skip", "selected"].map((name) => ({ name, inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: { value: { type: "number" } } } })),
    onCall() { return { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], structuredContent: { value: 42 } }; },
  });
  const mcp = new AgentMcpTools(agent([http(remote.url, { tools: ["selected"] })]), "/tmp/test");
  try {
    await mcp.connect({ secrets: [] });
    assert.deepEqual(mcp.tools.map((tool) => tool.name), [mcpToolName("remote", "selected")]);
    assert.equal(mcp.discoveredTools.length, 2);
    assert.deepEqual(mcp.tools[0]?.outputSchema, { type: "object", properties: { value: { type: "number" } } });
    const result = await mcp.tools[0]!.execute("call", {}, () => {}, {} as never, {} as never, {} as never);
    assert.deepEqual(result.content, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
    assert.deepEqual(result.structuredContent, { value: 42 });
  } finally { await mcp.close(); await remote.close(); }
});
