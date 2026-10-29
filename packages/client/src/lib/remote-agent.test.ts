import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  AgentRunEvent,
  AgentRunEventEnvelope,
  AgentRunResult,
  SessionConnection,
} from "@carmel-agent/shared";
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

test("Home refresh preserves loaded pages and entry IDs while recent messages update", async () => {
  const originalFetch = globalThis.fetch;
  const earlier = userMessage("earlier");
  const recent = userMessage("recent");
  const reply = assistantMessage("new reply");
  if (reply.role === "assistant") delete reply.errorMessage;
  let latest = connection([recent], null);
  latest.session.messageEntryIds = ["recent"];
  latest.session.olderCursor = "older";
  let observed: SessionConnection | undefined;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/history"))
      return Response.json({
        ...latest.session,
        messages: [earlier],
        messageEntryIds: ["earlier"],
        olderCursor: "oldest",
      });
    return Response.json(latest);
  };
  try {
    const agent = new RemoteAgent({
      agentId: "agent_1",
      sessionId: "session_1",
      modelRefId: "model_1",
      model,
      thinkingLevel: "off",
      home: true,
      messages: [recent],
      messageEntryIds: ["recent"],
      olderCursor: "older",
      onConnection: (value) => {
        observed = value;
      },
    });
    await agent.loadOlder();
    assert.equal(agent.getSnapshot().loadedEarlier, true);
    await agent.refreshHome();
    assert.deepEqual(agent.getSnapshot().messages, [earlier, recent]);
    assert.equal(agent.getSnapshot().olderCursor, "oldest");
    assert.equal(agent.getSnapshot().historyOnly, false);
    latest = connection([recent, reply], null);
    latest.session.messageEntryIds = ["recent", "reply"];
    latest.session.olderCursor = "older";
    await agent.refreshHome();
    assert.deepEqual(agent.getSnapshot().messages, [earlier, recent, reply]);
    assert.deepEqual(observed?.session.messageEntryIds, ["earlier", "recent", "reply"]);
    await agent.refreshConnection();
    assert.deepEqual(agent.getSnapshot().messages, [recent, reply]);
    assert.equal(agent.getSnapshot().loadedEarlier, false);
    assert.equal(agent.getSnapshot().olderCursor, "older");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Home discards loaded pages when the current branch no longer overlaps them", async () => {
  const originalFetch = globalThis.fetch;
  const recent = userMessage("recent");
  const replacement = userMessage("replacement branch");
  globalThis.fetch = async () =>
    Response.json({
      ...connection([recent], null).session,
      messages: [userMessage("earlier")],
      messageEntryIds: ["earlier"],
    });
  try {
    const agent = new RemoteAgent({
      agentId: "agent_1",
      sessionId: "session_1",
      modelRefId: "model_1",
      model,
      thinkingLevel: "off",
      home: true,
      messages: [recent],
      messageEntryIds: ["recent"],
      olderCursor: "older",
    });
    await agent.loadOlder();
    assert.equal(agent.getSnapshot().olderCursor, undefined);
    assert.equal(agent.getSnapshot().loadedEarlier, true);
    const latest = connection([replacement], null);
    latest.session.messageEntryIds = ["replacement"];
    globalThis.fetch = async () => Response.json(latest);
    await agent.refreshHome();
    assert.deepEqual(agent.getSnapshot().messages, [replacement]);
    assert.equal(agent.getSnapshot().olderCursor, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Home keeps earlier pages while attaching to a live reply and applying its final snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const earlier = userMessage("earlier");
  const recent = userMessage("recent");
  const reply = assistantMessage("live reply");
  const latest = connection([recent, reply], null);
  latest.session.messageEntryIds = ["recent", "reply"];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/history"))
      return Response.json({
        ...latest.session,
        messages: [earlier],
        messageEntryIds: ["earlier"],
      });
    if (url.includes("/events"))
      return eventResponse([
        envelope(1, { type: "message_end", message: reply }),
        envelope(2, runFinished()),
      ]);
    const current = connection([recent], {
      runId: "home_live",
      sessionId: "session_1",
      eventCursor: 0,
    });
    current.session.messageEntryIds = ["recent"];
    return Response.json(current);
  };
  try {
    const agent = new RemoteAgent({
      agentId: "agent_1",
      sessionId: "session_1",
      modelRefId: "model_1",
      model,
      thinkingLevel: "off",
      home: true,
      messages: [recent],
      messageEntryIds: ["recent"],
      olderCursor: "older",
      onRunComplete: () => {
        agent.applyConnectionSnapshot(latest);
        finish();
      },
    });
    await agent.loadOlder();
    const snapshots: AgentMessage[][] = [];
    agent.subscribeStore(() => snapshots.push(agent.getSnapshot().messages));
    await agent.refreshHome();
    await finished;
    assert.ok(
      snapshots.every(
        (messages) => messages[0]?.role === "user" && messages[0].content === "earlier",
      ),
    );
    assert.deepEqual(agent.getSnapshot().messages, [earlier, recent, reply]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Home preserves a bounded history window until Latest messages is requested", async () => {
  const originalFetch = globalThis.fetch;
  const recent = userMessage("recent");
  const earlier = Array.from({ length: 499 }, (_, index) => userMessage(`earlier ${index}`));
  const reply = assistantMessage("new reply");
  if (reply.role === "assistant") delete reply.errorMessage;
  const latest = connection([recent, reply], null);
  latest.session.messageEntryIds = ["recent", "reply"];
  globalThis.fetch = async (input) =>
    Response.json(
      String(input).includes("/history")
        ? {
            ...latest.session,
            messages: earlier,
            messageEntryIds: earlier.map((_, index) => `earlier_${index}`),
            olderCursor: "oldest",
          }
        : latest,
    );
  try {
    const agent = new RemoteAgent({
      agentId: "agent_1",
      sessionId: "session_1",
      modelRefId: "model_1",
      model,
      thinkingLevel: "off",
      home: true,
      messages: [recent],
      messageEntryIds: ["recent"],
      olderCursor: "older",
    });
    await agent.loadOlder();
    await agent.refreshHome();
    assert.equal(agent.getSnapshot().messages.length, 500);
    assert.equal(agent.getSnapshot().historyOnly, true);
    assert.equal(agent.getSnapshot().olderCursor, "oldest");
    await agent.refreshHome();
    assert.deepEqual(agent.getSnapshot().messages, [...earlier, recent]);
    await agent.refreshConnection();
    assert.deepEqual(agent.getSnapshot().messages, latest.session.messages);
    assert.equal(agent.getSnapshot().historyOnly, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
      return eventResponse([
        envelope(8, { type: "message_end", message: streamed }),
        envelope(9, agentEnd()),
        envelope(10, runFinished()),
      ]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([question, persisted], async () => agent.setMessages(final));
    await agent.attachToRun("run_cursor", [question, persisted], 7);

    assert.deepEqual(requests, ["/api/agent-runs/run_cursor/events?after=7"]);
    assert.deepEqual(agent.getSnapshot().messages, final);
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
      return eventResponse([
        envelope(3, { type: "message_end", message: streamed }),
        envelope(4, agentEnd()),
        envelope(5, runFinished()),
      ]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([question], async () => agent.setMessages(final));
    await agent.attachToRun("run_reconnect", [question], 1);

    assert.deepEqual(requests, [
      { url: "/api/agent-runs/run_reconnect/events?after=1", method: "GET" },
      { url: "/api/agent-runs/run_reconnect/events?after=2", method: "GET" },
    ]);
    assert.equal(
      requests.some((request) => request.url.includes("/abort")),
      false,
    );
    assert.deepEqual(agent.getSnapshot().messages, final);
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
      return Response.json(
        connection([question], { runId: "run_recovered", sessionId: "session_1", eventCursor: 1 }),
      );
    }
    if (url.endsWith("/events?after=1")) {
      return eventResponse([
        envelope(2, { type: "message_end", message: answer }),
        envelope(3, agentEnd()),
        envelope(4, runFinished()),
      ]);
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
    ]);
    assert.equal(
      requests.some((request) => request.url.includes("/abort")),
      false,
    );
    assert.deepEqual(agent.getSnapshot().messages, final);
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
      return Response.json(
        connection(authoritative, { runId: "run_gap", sessionId: "session_1", eventCursor: 10 }),
      );
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
    assert.deepEqual(agent.getSnapshot().messages, final);
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
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  };
  try {
    const agent = createAgent([userMessage("question")]);
    const observing = agent.attachToRun("run_detach", agent.getSnapshot().messages, 3);
    await Promise.resolve();
    agent.detach();
    await observing;

    assert.deepEqual(requests, [
      { url: "/api/agent-runs/run_detach/events?after=3", method: "GET" },
    ]);
    assert.equal(agent.getSnapshot().isStreaming, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stop before the run id is known still aborts that run", async () => {
  const originalFetch = globalThis.fetch;
  const aborted = assistantMessage("partial", "aborted");
  let releaseRun: (response: Response) => void = () => {};
  const runResponse = new Promise<Response>((resolve) => {
    releaseRun = resolve;
  });
  const requests: Array<{ url: string; method: string }> = [];
  let agent: RemoteAgent;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (method === "POST" && url.endsWith("/run")) return runResponse;
    if (method === "POST" && url.endsWith("/abort")) return Response.json({ ok: true });
    if (url.includes("/events?")) {
      return eventResponse([
        envelope(1, { type: "message_start", message: assistantMessage("") }),
        envelope(2, {
          type: "message_update",
          usage: emptyUsage(),
          changes: [{ type: "thinking_delta", contentIndex: 0, delta: "kept going" }],
        }),
        envelope(3, { type: "message_end", message: aborted }),
        envelope(4, runFinished({ outcome: "cancelled" })),
      ]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([]);
    const prompting = agent.prompt("question");
    await Promise.resolve();
    await agent.abort();
    assert.equal(
      requests.some((request) => request.method === "POST" && request.url.endsWith("/abort")),
      false,
    );

    releaseRun(
      Response.json(
        { runId: "run_early_stop" },
        { headers: { "x-agent-run-id": "run_early_stop" } },
      ),
    );
    await prompting;

    assert.deepEqual(
      requests.filter((request) => request.method === "POST" && request.url.endsWith("/abort")),
      [{ url: "/api/agent-runs/run_early_stop/abort", method: "POST" }],
    );
    assert.equal(agent.getSnapshot().isStreaming, false);
    // The event stream is JSON, so an omitted errorMessage does not come back.
    assert.deepEqual(agent.getSnapshot().messages, [JSON.parse(JSON.stringify(aborted))]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stopping while thinking is on screen aborts the run and still applies server events", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const aborted = assistantMessage("partial", "aborted");
  const requests: Array<{ url: string; method: string }> = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let agent: RemoteAgent;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });
    if (method === "POST" && url.endsWith("/abort")) return Response.json({ ok: true });
    if (url.includes("/events?")) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            streamController = controller;
          },
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  try {
    agent = createAgent([question]);
    const observing = agent.attachToRun("run_thinking", [question], 0);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(streamController);
    streamController.enqueue(
      encodeEvents([
        envelope(1, { type: "message_start", message: assistantMessage("") }),
        envelope(2, {
          type: "message_update",
          usage: emptyUsage(),
          changes: [{ type: "thinking_delta", contentIndex: 0, delta: "first" }],
        }),
      ]),
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(thinkingText(agent.getSnapshot().streamingMessage), "first");

    await agent.abort();
    streamController.enqueue(
      encodeEvents([
        envelope(3, {
          type: "message_update",
          usage: emptyUsage(),
          changes: [{ type: "thinking_delta", contentIndex: 0, delta: " and more" }],
        }),
      ]),
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(thinkingText(agent.getSnapshot().streamingMessage), "first and more");

    streamController.enqueue(
      encodeEvents([
        envelope(4, { type: "message_end", message: aborted }),
        envelope(5, runFinished({ outcome: "cancelled" })),
      ]),
    );
    streamController.close();
    await observing;

    assert.deepEqual(
      requests.filter((request) => request.method === "POST" && request.url.endsWith("/abort")),
      [{ url: "/api/agent-runs/run_thinking/abort", method: "POST" }],
    );
    assert.deepEqual(agent.getSnapshot().messages, [question, JSON.parse(JSON.stringify(aborted))]);
    assert.equal(agent.getSnapshot().isStreaming, false);
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
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              streamController = controller;
            },
          }),
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

    assert.equal(agent.getSnapshot().isStreaming, true);
    assert.ok(streamController);
    streamController.enqueue(
      encodeEvents([
        envelope(1, { type: "message_end", message: aborted }),
        envelope(2, { type: "turn_end", errorMessage: "Stopped by user" }),
        envelope(3, agentEnd()),
        envelope(4, runFinished()),
      ]),
    );
    streamController.close();
    await observing;

    assert.equal(
      requests.filter((request) => request.method === "POST" && request.url.endsWith("/abort"))
        .length,
      1,
    );
    assert.deepEqual(agent.getSnapshot().messages, final);
    assert.equal(agent.getSnapshot().errorMessage, "Stopped by user");
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
          envelope(2, { type: "turn_end", errorMessage: "Provider failed" }),
          envelope(3, agentEnd()),
          envelope(4, runFinished()),
        ]);
      }
      return new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    agent = createAgent([question], async () => agent.setMessages(final));
    await agent.attachToRun("run_failure", [question], 0);

    assert.deepEqual(agent.getSnapshot().messages, final);
    assert.equal(
      agent.getSnapshot().messages.filter((message) => message.role === "assistant").length,
      1,
    );
    assert.equal(agent.getSnapshot().errorMessage, "Provider failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the streaming message is rebuilt from deltas and tool-call parts", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const answer = assistantMessage("Hello, world");
  const snapshots: Array<AgentMessage | undefined> = [];
  let agent: RemoteAgent;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/events?")) {
      return eventResponse([
        envelope(1, { type: "message_start", message: assistantMessage("") }),
        envelope(2, {
          type: "message_update",
          usage: (answer as import("@earendil-works/pi-ai").AssistantMessage).usage,
          changes: [{ type: "thinking_delta", contentIndex: 0, delta: "let me think" }],
        }),
        envelope(3, {
          type: "message_update",
          usage: (answer as import("@earendil-works/pi-ai").AssistantMessage).usage,
          changes: [{ type: "text_delta", contentIndex: 1, delta: "Hello, " }],
        }),
        envelope(4, {
          type: "message_update",
          usage: (answer as import("@earendil-works/pi-ai").AssistantMessage).usage,
          changes: [{ type: "text_delta", contentIndex: 1, delta: "world" }],
        }),
        envelope(5, {
          type: "message_update",
          usage: (answer as import("@earendil-works/pi-ai").AssistantMessage).usage,
          changes: [
            {
              type: "block",
              contentIndex: 2,
              block: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
            },
          ],
        }),
        envelope(6, { type: "message_end", message: answer }),
        envelope(7, runFinished()),
      ]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([question]);
    agent.subscribeStore(() => snapshots.push(agent.getSnapshot().streamingMessage));
    await agent.attachToRun("run_delta", [question], 0);

    // `message_start` seeds an empty message; each delta extends it in place.
    const streamed = snapshots.filter((message) => message !== undefined);
    assert.deepEqual((streamed.at(-1) as AssistantMessage).content, [
      { type: "thinking", thinking: "let me think" },
      { type: "text", text: "Hello, world" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
    ]);
    // Every applied delta has to produce a fresh object, or the snapshot
    // identity check in useSyncExternalStore drops the render.
    assert.equal(new Set(streamed).size, streamed.length);
    assert.deepEqual(agent.getSnapshot().messages, JSON.parse(JSON.stringify([question, answer])));
    assert.equal(agent.getSnapshot().streamingMessage, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a rejected send reports the rejection and the error it failed with", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ error: "No provider credentials are configured." }, { status: 400 });
  try {
    const agent = createAgent([]);
    const sending = agent.prompt("question");
    const pending = agent.getSnapshot().messages.at(-1);
    assert.ok(pending?.role === "user");
    assert.deepEqual(pending.content, [{ type: "text", text: "question" }]);
    const outcome = await sending;

    assert.equal(outcome.status, "rejected");
    assert.match(agent.getSnapshot().errorMessage ?? "", /provider credentials/i);
    // Nothing was admitted, so the transcript must not pretend otherwise.
    assert.deepEqual(agent.getSnapshot().messages, []);
    assert.equal(agent.getSnapshot().isStreaming, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Home shows queued messages immediately and reconciles each admission with its persisted input", async () => {
  const originalFetch = globalThis.fetch;
  const earlier = { ...userMessage("same text"), homeEventId: "earlier" };
  const first = { ...userMessage("expanded command"), homeEventId: "event_1" };
  const second = { ...userMessage("same text"), homeEventId: "event_2" };
  const agent = new RemoteAgent({
    agentId: "agent_1",
    sessionId: "session_1",
    modelRefId: "model_1",
    model,
    thinkingLevel: "off",
    home: true,
    messages: [earlier],
  });
  let admit!: (response: Response) => void;
  let nextEvent = 1;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST")
      return new Promise<Response>((resolve) => {
        admit = resolve;
      });
    return Response.json(connection([earlier], null));
  };
  try {
    for (const text of ["/command", "same text"]) {
      const sending = agent.prompt(text);
      const pending = agent.getSnapshot().messages.at(-1);
      assert.ok(pending?.role === "user");
      assert.deepEqual(pending.content, [{ type: "text", text }]);
      admit(Response.json({ eventId: `event_${nextEvent++}` }));
      assert.equal((await sending).status, "accepted");
    }
    agent.applyConnectionSnapshot(connection([earlier], null));
    assert.equal(agent.getSnapshot().messages.length, 3);
    agent.applyConnectionSnapshot(connection([earlier, first], null));
    assert.equal(agent.getSnapshot().messages.length, 3);
    assert.deepEqual(agent.getSnapshot().messages[1], first);
    agent.applyConnectionSnapshot(connection([earlier, first, second], null));
    assert.deepEqual(agent.getSnapshot().messages, [earlier, first, second]);
    agent.applyConnectionSnapshot(connection([earlier, first, second], null));
    assert.deepEqual(agent.getSnapshot().messages, [earlier, first, second]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reference-only messages send structured selections without inventing context on the client", async () => {
  const originalFetch = globalThis.fetch;
  const references = [{ kind: "folder" as const, path: "docs" }];
  let submitted: unknown;
  globalThis.fetch = async (_input, init) => {
    submitted = JSON.parse(String(init?.body));
    return Response.json({ error: "Reference unavailable" }, { status: 400 });
  };
  try {
    const outcome = await createAgent([]).prompt("", undefined, references);
    assert.equal(outcome.status, "rejected");
    assert.deepEqual((submitted as { promptInput: unknown }).promptInput, { text: "", references });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a send refused because the session is busy is rejected, not silently swallowed", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("earlier question");
  const answer = assistantMessage("answer to the earlier question");
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.endsWith("/run")) {
      return Response.json(
        { runId: "run_busy" },
        { status: 409, headers: { "x-agent-run-id": "run_busy" } },
      );
    }
    if (url.endsWith("/sessions/session_1/connection")) {
      return Response.json(
        connection([question], { runId: "run_busy", sessionId: "session_1", eventCursor: 1 }),
      );
    }
    if (url.endsWith("/events?after=1")) {
      return eventResponse([
        envelope(2, { type: "message_end", message: answer }),
        envelope(3, agentEnd()),
        envelope(4, runFinished()),
      ]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    const agent = createAgent([]);
    const outcome = await agent.prompt("question");

    // The client still follows the run holding the session, but the message it
    // tried to send was never accepted by it.
    assert.equal(outcome.status, "rejected");
    assert.deepEqual(
      agent.getSnapshot().messages.map((message) => message.role),
      [question.role, answer.role],
    );
    assert.match(agent.getSnapshot().errorMessage ?? "", /run in progress/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a submission that may have landed is unknown rather than rejected", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.endsWith("/run"))
      throw new Error("response socket lost");
    if (url.endsWith("/sessions/session_1/connection")) return Response.json(connection([], null));
    return new Response(null, { status: 404 });
  };
  try {
    const agent = createAgent([]);
    const outcome = await agent.prompt("question");

    // The request left this client and no run answers for it. Reporting it as
    // rejected would invite a resend of a message the server may already hold.
    assert.equal(outcome.status, "unknown");
    assert.ok(agent.getSnapshot().errorMessage);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a run that fails after admission is still an accepted submission", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const failed = assistantMessage("", "error", "Provider rejected the request with 401.");
  let agent: RemoteAgent;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.endsWith("/run")) {
      assert.equal(
        JSON.parse(String(init?.body)).timezone,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      return Response.json(
        { runId: "run_failing" },
        { headers: { "x-agent-run-id": "run_failing" } },
      );
    }
    if (url.includes("/events?")) {
      return eventResponse([
        envelope(1, { type: "message_end", message: question }),
        envelope(2, agentEnd()),
        envelope(3, runFinished()),
      ]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([], async () => agent.setMessages([question, failed]));
    const outcome = await agent.prompt("question");

    // The server took the message; its failure belongs to the transcript, and
    // handing the prompt back to the composer would duplicate it.
    assert.equal(outcome.status, "accepted");
    assert.deepEqual(agent.getSnapshot().messages, [question, failed]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a run that failed where no turn could say so reports the server's reason", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const answer = assistantMessage("answer");
  let agent: RemoteAgent;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/events?")) {
      return eventResponse([
        envelope(1, { type: "message_end", message: answer }),
        envelope(2, { type: "turn_end" }),
        envelope(3, agentEnd()),
        envelope(
          4,
          runFinished({
            outcome: "failed",
            detail: "The run's result could not be saved: disk I/O error",
          }),
        ),
      ]);
    }
    return new Response(null, { status: 404 });
  };
  try {
    agent = createAgent([question], async () => agent.setMessages([question, answer]));
    await agent.attachToRun("run_unsaved", [question], 0);
    assert.equal(
      agent.getSnapshot().errorMessage,
      "The run's result could not be saved: disk I/O error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a turn's own error wording is kept over the run's result, and a cancelled run adds nothing", async () => {
  const originalFetch = globalThis.fetch;
  const question = userMessage("question");
  const streams = [
    [
      envelope(1, { type: "turn_end", errorMessage: "The provider rejected the API key." }),
      envelope(2, runFinished({ outcome: "failed", detail: "Provider error." })),
    ],
    [envelope(1, agentEnd()), envelope(2, runFinished({ outcome: "cancelled" }))],
  ];
  let stream = 0;
  globalThis.fetch = async (input) =>
    String(input).includes("/events?")
      ? eventResponse(streams[stream++]!)
      : new Response(null, { status: 404 });
  try {
    const failed = createAgent([question]);
    await failed.attachToRun("run_rejected", [question], 0);
    assert.equal(failed.getSnapshot().errorMessage, "The provider rejected the API key.");

    const cancelled = createAgent([question]);
    await cancelled.attachToRun("run_cancelled", [question], 0);
    assert.equal(cancelled.getSnapshot().errorMessage, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dismissing an error clears it from the snapshot", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  try {
    const agent = createAgent([]);
    await agent.prompt("question");
    assert.ok(agent.getSnapshot().errorMessage);

    agent.dismissError();
    assert.equal(agent.getSnapshot().errorMessage, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native nested progress stays outside messages and is cleared when observation finishes", async () => {
  const originalFetch = globalThis.fetch;
  const slots = [
    {
      callId: "parent/c1",
      name: "read",
      status: "running",
      taskId: 2,
      parentTaskId: 1,
      parentCallId: "parent",
      arguments: {},
    },
  ] as import("@carmel-agent/shared").NestedToolSlot[];
  globalThis.fetch = async () =>
    eventResponse([
      envelope(1, {
        type: "tool_execution_start",
        args: {},
        toolCallId: "parent",
        toolName: "codemode",
      }),
      envelope(2, { type: "nested_tools", tools: slots }),
      envelope(3, { type: "tool_execution_end", toolCallId: "parent", toolName: "codemode" }),
      envelope(4, runFinished()),
    ]);
  try {
    const agent = createAgent([]);
    let sawProgress = false;
    agent.subscribeStore(() => {
      if (agent.getSnapshot().nestedTools?.length) {
        sawProgress = true;
        assert.deepEqual(agent.getSnapshot().nestedTools, slots);
        assert.deepEqual(agent.getSnapshot().messages, []);
      }
    });
    await agent.attachToRun("run_codemode", [], 0);
    assert.equal(sawProgress, true);
    assert.equal(agent.getSnapshot().nestedTools?.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("native nested lifecycle updates bounded output without creating transcript messages", async () => {
  const originalFetch = globalThis.fetch;
  const nested = {
    toolCallId: "parent/c1",
    toolName: "read",
    taskId: 2 as never,
    parentToolCallId: "parent",
    parentTaskId: 1 as never,
  };
  globalThis.fetch = async () =>
    eventResponse([
      envelope(1, {
        type: "tool_execution_start",
        toolCallId: "parent",
        toolName: "codemode",
        args: {},
      }),
      envelope(2, { type: "tool_execution_start", ...nested, args: { path: "file" } }),
      envelope(3, { type: "tool_execution_update", ...nested, output: { set: "old" } }),
      envelope(4, {
        type: "tool_execution_update",
        ...nested,
        output: { trimStart: 1, append: "!" },
        details: { progress: 1 },
        diagnostics: [],
      }),
      envelope(5, {
        type: "tool_execution_end",
        ...nested,
        result: { taskId: 2 as never, isError: false, diagnostics: [], durationMs: 12 },
      }),
      envelope(6, { type: "tool_execution_end", toolCallId: "parent", toolName: "codemode" }),
      envelope(7, runFinished()),
    ]);
  try {
    const agent = createAgent([]);
    const states: import("@carmel-agent/shared").NestedToolSlot[] = [];
    agent.subscribeStore(() => {
      const snapshot = agent.getSnapshot();
      if (snapshot.nestedTools?.[0]) states.push(snapshot.nestedTools[0]);
      assert.deepEqual(snapshot.messages, []);
      assert.equal(snapshot.pendingToolCalls.has(nested.toolCallId), false);
    });
    await agent.attachToRun("run_native_lifecycle", [], 0);
    assert.ok(states.some((call) => call.status === "running" && call.arguments.path === "file"));
    assert.ok(
      states.some(
        (call) => call.output === "ld!" && JSON.stringify(call.details) === '{"progress":1}',
      ),
    );
    assert.ok(
      states.some(
        (call) =>
          call.status === "done" &&
          call.summary?.durationMs === 12 &&
          call.summary.isError === false,
      ),
    );
    assert.deepEqual(agent.getSnapshot().nestedTools, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resume admits saved work after a tool call without resending or rewinding the user message", async () => {
  const originalFetch = globalThis.fetch;
  const messages = [userMessage("original"), assistantMessage("pending tool")];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/run")) {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.sessionId, "session_1");
      assert.equal(body.promptInput, undefined);
      return Response.json(
        { runId: "run_resumed" },
        { headers: { "x-agent-run-id": "run_resumed" } },
      );
    }
    if (url.includes("/events?")) return eventResponse([envelope(1, runFinished())]);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  try {
    const agent = createAgent(messages);
    agent.applyConnectionSnapshot({ ...connection(messages, null), pendingWork: true });
    assert.equal(agent.getSnapshot().hasPendingWork, true);
    assert.deepEqual(await agent.resume(), { status: "accepted" });
    assert.deepEqual(agent.getSnapshot().messages, messages);
    assert.equal(agent.getSnapshot().hasPendingWork, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Stop uses session authority for saved work when the server run ID was lost", async () => {
  const originalFetch = globalThis.fetch;
  const messages = [userMessage("original"), assistantMessage("pending tool")];
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/abort")) {
      assert.equal(init?.method, "POST");
      return Response.json({ ok: true });
    }
    return Response.json({ ...connection(messages, null), pendingWork: false });
  };
  try {
    const agent = createAgent(messages);
    agent.applyConnectionSnapshot({ ...connection(messages, null), pendingWork: true });
    await agent.abort();
    assert.deepEqual(paths, [
      "/api/sessions/session_1/abort",
      "/api/sessions/session_1/connection",
    ]);
    assert.equal(agent.getSnapshot().hasPendingWork, false);
    assert.equal(agent.getSnapshot().isStreaming, false);
    assert.deepEqual(agent.getSnapshot().messages, JSON.parse(JSON.stringify(messages)));
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
      messageEntryIds: messages.map((_, index) => `entry_${index}`),
      createdAt: 1,
      updatedAt: 1,
    },
    activeRun,
  };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function thinkingText(message: AgentMessage | undefined) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const part = message.content.find((item) => item.type === "thinking");
  return part?.type === "thinking" ? part.thinking : "";
}

function envelope(sequence: number, event: AgentRunEvent): AgentRunEventEnvelope {
  return { sequence, event };
}

function agentEnd(): AgentRunEvent {
  return { type: "agent_end" };
}

function runFinished(result: AgentRunResult = { outcome: "succeeded" }): AgentRunEvent {
  return { type: "run_finished", result };
}

function eventResponse(envelopes: AgentRunEventEnvelope[], headers?: Record<string, string>) {
  return new Response(encodeEvents(envelopes), { status: 200, headers });
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
