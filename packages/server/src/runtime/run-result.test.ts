import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { AgentRunResult } from "@carmel-agent/shared";
import { db, migrate, sqlite } from "../db/index.ts";
import { agents, modelRefs, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { resolveModelContext } from "../services/model-context.ts";
import { loadSession } from "../services/session-store.ts";
import { readActivity } from "../services/activity.ts";
import { createAgent, createUser } from "../test-support.ts";
import { abortAgentRun, startDetachedAgentRun, whenRunFinished } from "./agent-runtime.ts";
import { shutdownActiveRuns, type ActiveAgentRun } from "./run-stream.ts";

/**
 * How a real run ends, end to end: the runtime, Pi, and an OpenAI-compatible
 * provider on localhost that is told how to behave. Finishing is not the same
 * as succeeding, so every way a run can end is driven through the same path
 * chat and the scheduler use.
 */

migrate();

type ProviderMode = "reply" | "reject" | "tool-loop" | "hang";
const provider = await startFakeProvider();
after(() => provider.close());

test("a run that gets its reply succeeds", async () => {
  const run = await startRun("reply");
  assert.deepEqual(await finished(run), { outcome: "succeeded" });
});

test("a provider rejection fails the run and says why", async () => {
  // The case that used to read as success: Pi turns the 401 into an assistant
  // message with stopReason "error", and nothing throws.
  const run = await startRun("reject");
  const result = await finished(run);
  assert.equal(result.outcome, "failed");
  assert.match(result.detail ?? "", /API key|401|auth/i);
});

test("a run guard stop fails the run with the guard's reason", async () => {
  const previous = process.env.CARMEL_AGENT_MAX_TOOL_CALLS;
  process.env.CARMEL_AGENT_MAX_TOOL_CALLS = "1";
  try {
    const run = await startRun("tool-loop");
    const result = await finished(run);
    assert.equal(result.outcome, "failed");
    assert.match(result.detail ?? "", /stopped after 1 tool calls/);
  } finally {
    if (previous === undefined) delete process.env.CARMEL_AGENT_MAX_TOOL_CALLS;
    else process.env.CARMEL_AGENT_MAX_TOOL_CALLS = previous;
  }
});

test("a run a person stops is cancelled", async () => {
  const run = await startRun("hang");
  await provider.waitForRequest();
  assert.ok(abortAgentRun(run.userId, run.runId));
  assert.deepEqual(await finished(run), { outcome: "cancelled" });
});

test("a run cut off by shutdown is interrupted", async () => {
  const run = await startRun("hang");
  await provider.waitForRequest();
  await shutdownActiveRuns();
  assert.equal((await finished(run)).outcome, "interrupted");
});

test("a run whose result cannot be saved fails", async () => {
  const run = await startRun("reply", (sessionId) => {
    // The session row is committed at finalization; make exactly that write fail.
    sqlite.exec(`
      CREATE TRIGGER fail_session_commit BEFORE UPDATE ON sessions
      WHEN NEW.id = '${sessionId}'
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
    `);
  });
  try {
    const result = await finished(run);
    assert.equal(result.outcome, "failed");
    assert.match(result.detail ?? "", /could not be saved: disk I\/O error/);
  } finally {
    sqlite.exec("DROP TRIGGER IF EXISTS fail_session_commit");
  }
});

/** Waits for the run, and checks the stream's terminal event says the same thing. */
async function finished(run: ActiveAgentRun): Promise<AgentRunResult> {
  const result = await whenRunFinished(run, 20);
  const terminal = run.events.at(-1)?.event;
  assert.deepEqual(terminal, { type: "run_finished", result });
  const notifications = readActivity(run.userId).items.filter((item) => item.sessionId === run.sessionId);
  if (result.outcome === "cancelled") assert.equal(notifications.length, 0);
  else {
    assert.equal(notifications.length, 1, "a detached run records one durable inbox update");
    assert.equal(notifications[0]!.kind, result.outcome === "succeeded" ? "completed" : result.outcome);
  }
  return result;
}

async function startRun(mode: ProviderMode, beforeStart?: (sessionId: string) => void) {
  provider.mode = mode;
  const userId = createUser();
  const modelRefId = id("model_ref");
  const timestamp = now();
  db.insert(modelRefs)
    .values({
      id: modelRefId,
      ownerUserId: userId,
      label: "Fake",
      provider: "ollama",
      modelId: modelRefId,
      api: "openai-completions",
      baseUrl: `${provider.url}/v1`,
      input: ["text"],
      reasoning: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  const agentId = createAgent({ ownerUserId: userId, defaultModelRefId: modelRefId });
  const sessionId = id("session");
  db.insert(sessions)
    .values({ id: sessionId, title: "Test", userId, agentId, modelRefId, thinkingLevel: "off", createdAt: timestamp, updatedAt: timestamp })
    .run();

  const context = await resolveModelContext(userId, modelRefId);
  assert.ok(context.ok, "the fake provider's model did not resolve");
  const session = await loadSession(sessionId);
  assert.ok(session);
  beforeStart?.(sessionId);
  return startDetachedAgentRun({
    agent: db.select().from(agents).where(eq(agents.id, agentId)).get()!,
    session,
    modelRef: context.value.modelRef,
    providerConfig: context.value.providerConfig,
    modelRuntime: context.value.modelRuntime,
    thinkingLevel: "off",
    promptInput: { text: "Hello" },
  });
}

async function startFakeProvider() {
  let waiters: Array<() => void> = [];
  const state = { mode: "reply" as ProviderMode };
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    for (const resolve of waiters) resolve();
    waiters = [];
    respond(state.mode, request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get mode() {
      return state.mode;
    },
    set mode(mode: ProviderMode) {
      state.mode = mode;
    },
    waitForRequest: () => new Promise<void>((resolve) => waiters.push(resolve)),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function respond(mode: ProviderMode, request: IncomingMessage, response: ServerResponse) {
  if (mode === "reject") {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (mode === "hang") {
    // Headers and nothing else: a provider that accepted the request and went quiet.
    request.on("close", () => response.end());
    return;
  }
  const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "fake" };
  const chunk = (delta: object, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  if (mode === "tool-loop") {
    // Asks for the same tool every turn, so only the guard ends the run.
    response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "missing.txt" }) } }] }));
    response.write(chunk({}, "tool_calls"));
  } else {
    response.write(chunk({ role: "assistant", content: "Hi there." }));
    response.write(chunk({}, "stop"));
  }
  response.end("data: [DONE]\n\n");
}
