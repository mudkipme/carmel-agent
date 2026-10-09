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
          type: "message_delta",
          contentIndex: 0,
          field: "thinking",
          delta: "let me think",
        }),
        envelope(3, { type: "message_delta", contentIndex: 1, field: "text", delta: "Hello, " }),
        envelope(4, { type: "message_delta", contentIndex: 1, field: "text", delta: "world" }),
        envelope(5, {
          type: "message_part",
          contentIndex: 2,
          part: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
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
    const outcome = await agent.prompt("question");

    assert.equal(outcome.status, "rejected");
    assert.match(agent.getSnapshot().errorMessage ?? "", /provider credentials/i);
    // Nothing was admitted, so the transcript must not pretend otherwise.
    assert.deepEqual(agent.getSnapshot().messages, []);
    assert.equal(agent.getSnapshot().isStreaming, false);
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
      return eventResponse(
        [envelope(1, { type: "message_end", message: question }), envelope(2, agentEnd())],
        { "x-agent-run-id": "run_failing" },
      );
    }
    if (url.endsWith("/events?after=2")) return eventResponse([envelope(3, runFinished())]);
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

test("codemode progress stays outside messages and is cleared when observation finishes", async () => {
  const originalFetch = globalThis.fetch;
  const codemodeCalls = [
    {
      id: "nested",
      name: "mcp_echo",
      label: "MCP echo",
      status: "running" as const,
      durationMs: 0,
    },
  ];
  globalThis.fetch = async () =>
    eventResponse([
      envelope(1, { type: "tool_execution_start", toolCallId: "call", toolName: "codemode" }),
      envelope(2, { type: "tool_execution_update", toolCallId: "call", codemodeCalls }),
      envelope(3, {
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: "codemode",
        isError: false,
      }),
      envelope(4, runFinished()),
    ]);
  try {
    const agent = createAgent([]);
    let sawProgress = false;
    agent.subscribeStore(() => {
      if (agent.getSnapshot().codemodeCalls?.get("call")) {
        sawProgress = true;
        assert.deepEqual(agent.getSnapshot().codemodeCalls?.get("call"), codemodeCalls);
        assert.deepEqual(agent.getSnapshot().messages, []);
      }
    });
    await agent.attachToRun("run_codemode", [], 0);
    assert.equal(sawProgress, true);
    assert.equal(agent.getSnapshot().codemodeCalls?.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resume admits saved work after a tool call without resending or rewinding the user message", async () => {
  const originalFetch = globalThis.fetch;
  const messages = [userMessage("original"), assistantMessage("pending tool")];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/agents/agent_1/run");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.sessionId, "session_1");
    assert.equal(body.promptInput, undefined);
    return eventResponse([envelope(1, runFinished())], { "x-agent-run-id": "run_resumed" });
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
