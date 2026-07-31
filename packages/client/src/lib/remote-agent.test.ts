import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentRunEventEnvelope, SessionConnection } from "@carmel-agent/shared";
import { RemoteAgent } from "./remote-agent.ts";

const model = {
  id: "test-model",
  name: "Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} as Model<Api>;

test("reconnect starts after the snapshot cursor and does not duplicate persisted messages", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const persisted = assistantMessage("already persisted");
  const streamed = assistantMessage("new after snapshot");
  const final = [question, persisted, streamed];
  const requests: string[] = [];
  let agent: RemoteAgent;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/events?after=7")) {
      return eventResponse([envelope(8, { type: "message_end", message: streamed }), envelope(9, agentEnd(streamed))]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([question, persisted], async () => agent.setMessages(final));
    await agent.attachToRun("run_cursor", [question, persisted], 7);

    assert.deepEqual(requests, [
      "/api/agent-runs/run_cursor/events?after=7",
      "/api/agent-runs/run_cursor/events?after=9",
    ]);
    assert.deepEqual(agent.state.messages, final);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a broken observer stream reconnects after the last received sequence without stopping the run", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const streamed = assistantMessage("streaming");
  const final = [question, streamed];
  const requests: Array<{ url: string; method: string }> = [];
  let agent: RemoteAgent;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/events?after=1")) {
      return failingEventResponse(envelope(2, { type: "message_start", message: streamed }));
    }
    if (url.endsWith("/events?after=2")) {
      return eventResponse([envelope(3, { type: "message_end", message: streamed }), envelope(4, agentEnd(streamed))]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([question], async () => agent.setMessages(final));
    await agent.attachToRun("run_reconnect", [question], 1);

    assert.deepEqual(requests, [
      { url: "/api/agent-runs/run_reconnect/events?after=1", method: "GET" },
      { url: "/api/agent-runs/run_reconnect/events?after=2", method: "GET" },
      { url: "/api/agent-runs/run_reconnect/events?after=4", method: "GET" },
    ]);
    assert.equal(requests.some((request) => request.url.includes("/abort")), false);
    assert.deepEqual(agent.state.messages, final);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an uncertain submit response recovers the server-owned run through session authority", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const answer = assistantMessage("answer");
  const final = [question, answer];
  const requests: Array<{ url: string; method: string }> = [];
  let agent: RemoteAgent;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (method === "POST" && url.endsWith("/run")) throw new Error("response socket lost");
    if (url.endsWith("/sessions/session_1/connection")) {
      return Response.json(connection([question], { runId: "run_recovered", sessionId: "session_1", eventCursor: 1 }));
    }
    if (url.endsWith("/events?after=1")) {
      return eventResponse([envelope(2, { type: "message_end", message: answer }), envelope(3, agentEnd(answer))]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([], async () => agent.setMessages(final));
    await agent.prompt("question");

    assert.deepEqual(requests, [
      { url: "/api/agents/agent_1/run", method: "POST" },
      { url: "/api/sessions/session_1/connection", method: "GET" },
      { url: "/api/agent-runs/run_recovered/events?after=1", method: "GET" },
      { url: "/api/agent-runs/run_recovered/events?after=3", method: "GET" },
    ]);
    assert.equal(requests.some((request) => request.url.includes("/abort")), false);
    assert.deepEqual(agent.state.messages, final);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a replay gap replaces local messages with one authoritative connection snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const stale = [userMessage("stale")];
  const authoritative = [userMessage("persisted"), assistantMessage("persisted reply")];
  const streamed = assistantMessage("after refreshed cursor");
  const final = [...authoritative, streamed];
  const requests: string[] = [];
  let agent: RemoteAgent;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/events?after=5")) return new Response("gap", { status: 409 });
    if (url.endsWith("/sessions/session_1/connection")) {
      return Response.json(connection(authoritative, { runId: "run_gap", sessionId: "session_1", eventCursor: 10 }));
    }
    if (url.endsWith("/events?after=10")) {
      return eventResponse([envelope(11, { type: "message_end", message: streamed })]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent(stale, async () => agent.setMessages(final));
    await agent.attachToRun("run_gap", stale, 5);

    assert.deepEqual(requests, [
      "/api/agent-runs/run_gap/events?after=5",
      "/api/sessions/session_1/connection",
      "/api/agent-runs/run_gap/events?after=10",
      "/api/agent-runs/run_gap/events?after=11",
    ]);
    assert.deepEqual(agent.state.messages, final);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("detaching cancels only the observer request and never calls the stop API", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  try {
    const agent = createAgent([userMessage("question")]);
    const observing = agent.attachToRun("run_detach", agent.state.messages, 3);
    await Promise.resolve();
    agent.detach();
    await observing;

    assert.deepEqual(requests, [{ url: "/api/agent-runs/run_detach/events?after=3", method: "GET" }]);
    assert.equal(agent.state.isStreaming, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual stop uses the abort API but keeps watching the server-persisted aborted result", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const aborted = assistantMessage("", "aborted", "Stopped by user");
  const final = [question, aborted];
  const requests: Array<{ url: string; method: string }> = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let eventRequests = 0;
  let agent: RemoteAgent;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (method === "POST" && url.endsWith("/abort")) return Response.json({ ok: true });
    if (url.includes("/events?")) {
      eventRequests += 1;
      if (eventRequests === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({ start: (controller) => { streamController = controller; } }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  try {
    agent = createAgent([question], async () => agent.setMessages(final));
    const observing = agent.attachToRun("run_abort", [question], 0);
    await Promise.resolve();
    await Promise.resolve();
    await agent.abort();

    assert.equal(agent.state.isStreaming, true);
    assert.ok(streamController);
    streamController.enqueue(encodeEvents([
      envelope(1, { type: "message_end", message: aborted }),
      envelope(2, { type: "turn_end", message: aborted, toolResults: [] }),
      envelope(3, agentEnd(aborted)),
    ]));
    streamController.close();
    await observing;

    assert.equal(requests.filter((request) => request.method === "POST" && request.url.endsWith("/abort")).length, 1);
    assert.deepEqual(agent.state.messages, final);
    assert.equal(agent.state.errorMessage, "Stopped by user");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a server-persisted model failure is authoritative and is not duplicated synthetically", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const failure = assistantMessage("", "error", "Provider failed");
  const final = [question, failure];
  let eventRequests = 0;
  let agent: RemoteAgent;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/events?")) {
      eventRequests += 1;
      if (eventRequests === 1) {
        return eventResponse([
          envelope(1, { type: "message_end", message: failure }),
          envelope(2, { type: "turn_end", message: failure, toolResults: [] }),
          envelope(3, agentEnd(failure)),
        ]);
      }
      return new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    agent = createAgent([question], async () => agent.setMessages(final));
    await agent.attachToRun("run_failure", [question], 0);

    assert.deepEqual(agent.state.messages, final);
    assert.equal(agent.state.messages.filter((message) => message.role === "assistant").length, 1);
    assert.equal(agent.state.errorMessage, "Provider failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createAgent(messages: AgentMessage[], onRunComplete?: () => Promise<void> | void) {
  return new RemoteAgent({
    agentId: "agent_1",
    sessionId: "session_1",
    modelRefId: "model_1",
    model,
    thinkingLevel: "off",
    messages,
    onRunComplete,
  });
}

function connection(
  messages: AgentMessage[],
  activeRun: SessionConnection["activeRun"],
): SessionConnection {
  return {
    session: {
      id: "session_1",
      title: "Test",
      userId: "user_1",
      agentId: "agent_1",
      modelRefId: "model_1",
      thinkingLevel: "off",
      revision: 0,
      messages,
      createdAt: 1,
      updatedAt: 1,
    },
    activeRun,
  };
}

function envelope(sequence: number, event: AgentEvent): AgentRunEventEnvelope {
  return { sequence, event };
}

function agentEnd(message: AgentMessage): AgentEvent {
  return { type: "agent_end", messages: [message] };
}

function eventResponse(envelopes: AgentRunEventEnvelope[]) {
  return new Response(encodeEvents(envelopes), { status: 200 });
}

function failingEventResponse(first: AgentRunEventEnvelope) {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encodeEvents([first]));
          return;
        }
        controller.error(new Error("socket lost"));
      },
    }),
    { status: 200 },
  );
}

function encodeEvents(envelopes: AgentRunEventEnvelope[]) {
  return new TextEncoder().encode(envelopes.map((item) => JSON.stringify(item)).join("\n") + "\n");
}

function userMessage(content: string): AgentMessage {
  return { role: "user", content } as AgentMessage;
}

function assistantMessage(
  text: string,
  stopReason: "stop" | "error" | "aborted" = "stop",
  errorMessage?: string,
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}
