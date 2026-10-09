import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage, HarnessEvent } from "../effectors/pi-durable/index.ts";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
} from "@earendil-works/pi-ai/providers/faux";
import { applyStreamingEvent, isStreamingEvent, type AgentRunEvent } from "@carmel-agent/shared";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { attachTestHarness } from "../effectors/testing/pi-harness.ts";
import { classifyTurnFailure } from "../effectors/failure-classifier.ts";
import { isOverflowMessage, projectRunEvent } from "./run-events.ts";

initialize();

test("streamed text and thinking are projected to deltas, not snapshots", () => {
  assert.deepEqual(
    projectRunEvent(
      messageUpdate({
        type: "text_delta",
        contentIndex: 0,
        delta: "wor",
        partial: partial("Hello, wor"),
      }),
    ),
    { type: "message_delta", contentIndex: 0, field: "text", delta: "wor" },
  );
  assert.deepEqual(
    projectRunEvent(
      messageUpdate({ type: "thinking_delta", contentIndex: 1, delta: "hm", partial: partial("") }),
    ),
    { type: "message_delta", contentIndex: 1, field: "thinking", delta: "hm" },
  );
});

test("events the client cannot use are dropped rather than forwarded", () => {
  // `partial` repeats the whole message; the deltas already carry the content.
  assert.equal(
    projectRunEvent(messageUpdate({ type: "text_start", contentIndex: 0, partial: partial("") })),
    undefined,
  );
  assert.equal(
    projectRunEvent(
      messageUpdate({
        type: "text_end",
        contentIndex: 0,
        content: "Hello",
        partial: partial("Hello"),
      }),
    ),
    undefined,
  );
  assert.equal(
    projectRunEvent(harnessEvent({ type: "run_start", runId: "run_1", startedAt: 1 })),
    undefined,
  );
  assert.equal(
    projectRunEvent(harnessEvent({ type: "turn_start", runId: "run_1", turnId: "turn_1" })),
    undefined,
  );
  assert.equal(
    projectRunEvent(
      harnessEvent({
        type: "tool_update",
        runId: "run_1",
        turnId: "turn_1",
        toolCallId: "call_1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "x".repeat(100_000) }] },
      }),
    ),
    undefined,
  );
});

test("codemode progress projects only validated nested call metadata", () => {
  const codemodeCalls = [
    { id: "nested", name: "mcp_echo", label: "MCP echo", status: "running", durationMs: 0 },
  ];
  const event = harnessEvent({
    type: "tool_update",
    runId: "run",
    turnId: "turn",
    toolCallId: "call",
    toolName: "codemode",
    partialResult: {
      content: [{ type: "text", text: "private output" }],
      details: { codemodeCalls, other: "not forwarded" },
    },
  });
  assert.deepEqual(projectRunEvent(event), {
    type: "tool_execution_update",
    toolCallId: "call",
    codemodeCalls,
  });
  assert.equal(
    projectRunEvent(
      harnessEvent({
        ...event,
        partialResult: { content: [], details: { codemodeCalls: [{ status: "invalid" }] } },
      }),
    ),
    undefined,
  );
});

test("tool calls arrive whole, without their streamed argument JSON", () => {
  const started = partial("");
  started.content = [
    {
      type: "toolCall",
      id: "call_1",
      name: "read",
      arguments: {},
      partialJson: "",
      index: 0,
    } as never,
  ];
  assert.deepEqual(
    projectRunEvent(messageUpdate({ type: "toolcall_start", contentIndex: 0, partial: started })),
    {
      type: "message_part",
      contentIndex: 0,
      part: { type: "toolCall", id: "call_1", name: "read", arguments: {} },
    },
  );

  // Partial JSON needs Pi's salvage parser to read, so it never goes on the wire.
  assert.equal(
    projectRunEvent(
      messageUpdate({ type: "toolcall_delta", contentIndex: 0, delta: '{"pa', partial: started }),
    ),
    undefined,
  );

  assert.deepEqual(
    projectRunEvent(
      messageUpdate({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        partial: started,
      }),
    ),
    {
      type: "message_part",
      contentIndex: 0,
      part: { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
    },
  );
});

test("only an assistant message_start is forwarded", () => {
  const assistant = assistantMessage();
  assert.deepEqual(projectRunEvent(harnessEvent({ type: "message_start", message: assistant })), {
    type: "message_start",
    message: assistant,
  });

  // A tool result is emitted as start/end in the same tick; forwarding the start
  // would put the whole result on the wire twice.
  const toolResult = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text: "x".repeat(50_000) }],
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage;
  assert.equal(
    projectRunEvent(harnessEvent({ type: "message_start", message: toolResult })),
    undefined,
  );
  assert.deepEqual(projectRunEvent(harnessEvent({ type: "message_end", message: toolResult })), {
    type: "message_end",
    message: toolResult,
  });
});

test("bulk payloads are stripped from lifecycle events", () => {
  assert.deepEqual(
    projectRunEvent(
      harnessEvent({
        type: "tool_start",
        runId: "run_1",
        turnId: "turn_1",
        toolCallId: "call_1",
        toolName: "write",
        args: { content: "x".repeat(50_000) },
      }),
    ),
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "write" },
  );
  assert.deepEqual(
    projectRunEvent(
      harnessEvent({
        type: "tool_end",
        runId: "run_1",
        turnId: "turn_1",
        toolCallId: "call_1",
        toolName: "write",
        result: { content: [{ type: "text", text: "x".repeat(50_000) }] },
        isError: false,
        terminate: false,
      }),
    ),
    { type: "tool_execution_end", toolCallId: "call_1", toolName: "write", isError: false },
  );
  assert.deepEqual(
    projectRunEvent(
      harnessEvent({
        type: "run_end",
        runId: "run_1",
        status: "completed",
        fromTipId: null,
        tipId: "e1",
        endedAt: 1,
      }),
    ),
    { type: "agent_end" },
  );
});

test("turn_end carries only the error the client renders", () => {
  assert.deepEqual(
    projectRunEvent(
      harnessEvent({
        type: "turn_end",
        runId: "run_1",
        turnId: "turn_1",
        message: assistantMessage(),
        toolResults: [],
      }),
    ),
    {
      type: "turn_end",
    },
  );
  const failed = assistantMessage();
  failed.errorMessage = "Provider failed";
  assert.deepEqual(
    projectRunEvent(
      harnessEvent({
        type: "turn_end",
        runId: "run_1",
        turnId: "turn_1",
        message: failed,
        toolResults: [],
      }),
    ),
    {
      type: "turn_end",
      errorMessage: "Provider failed",
    },
  );
});

test("turn_end reports a silent overflow when it knows the window, as the run does", () => {
  // A provider that answers `stop` on a request already past the window: no
  // error text at all, so only the window reveals the overflow.
  const overran = assistantMessage();
  overran.usage = { ...overran.usage, input: 9_000, totalTokens: 9_000 };
  const event = harnessEvent({
    type: "turn_end",
    runId: "run_1",
    turnId: "turn_1",
    message: overran,
    toolResults: [],
  });

  assert.deepEqual(projectRunEvent(event), { type: "turn_end" });
  const projected = projectRunEvent(event, 8_192) as { errorMessage?: string };
  assert.ok(
    projected.errorMessage,
    "the client must hear about the overflow the server is recovering from",
  );
});

test("a real streamed turn reassembles byte-for-byte from the projected events", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({
    provider: `faux-stream-${crypto.randomUUID()}`,
    tokensPerSecond: 100_000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("weighing the options"),
      fauxText("Hello, world. ".repeat(40)),
    ]),
  ]);

  const piSession = await openPiSession(sessionId);
  const pi = await attachTestHarness(piSession, {
    models,
    model: faux.getModel(),
    systemPrompt: "Test assistant",
  });
  const projected: AgentRunEvent[] = [];
  let rawBytes = 0;
  const unsubscribe = pi.observe((event) => {
    rawBytes += Buffer.byteLength(JSON.stringify(event));
    const wireEvent = projectRunEvent(event);
    if (wireEvent) projected.push(wireEvent);
  });

  let final: AgentMessage | undefined;
  try {
    await pi.lane.prompt("hello", undefined, pi.context);
    final = (await pi.branch())
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
      .at(-1);
  } finally {
    unsubscribe();
    await pi.close();
  }

  // Replay the wire events exactly as the client does.
  let streaming: AgentMessage | undefined;
  for (const event of projected) {
    if (isStreamingEvent(event)) streaming = applyStreamingEvent(streaming, event);
  }

  assert.ok(final && final.role === "assistant");
  assert.ok(
    projected.some((event) => event.type === "message_delta"),
    "the turn must actually have streamed",
  );
  assert.deepEqual(
    (streaming as AssistantMessage | undefined)?.content,
    (final as AssistantMessage).content,
  );

  // Guard the property this protocol exists for: no event may carry a snapshot
  // of the message-so-far, so the stream stays linear in the reply length.
  const wireBytes = projected.reduce(
    (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
    0,
  );
  assert.ok(
    wireBytes < rawBytes,
    `projected stream should omit Pi's partial-message snapshots (${wireBytes} vs ${rawBytes} bytes)`,
  );
});

function messageUpdate(event: unknown): HarnessEvent {
  return harnessEvent({
    type: "message_update",
    runId: "run_1",
    message: assistantMessage(),
    event,
  });
}

function partial(text: string): AssistantMessage {
  return { ...assistantMessage(), content: text ? [{ type: "text", text }] : [] };
}

function assistantMessage(): AgentMessage & AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  } as AgentMessage & AssistantMessage;
}

function harnessEvent(
  payload: { type: HarnessEvent["type"] } & Record<string, unknown>,
): HarnessEvent {
  return payload as unknown as HarnessEvent;
}

/**
 * The regression guard for delegating overflow detection to Pi.
 *
 * Carmel used to carry its own pattern list; it now asks `isContextOverflow`.
 * That is the right call -- one list, and Pi's also knows which
 * overflow-shaped texts are really throttling -- but it moves a decision Carmel
 * depends on into a dependency. These are the provider strings Carmel was
 * written against, so if an upgrade stops recognising one, it fails here rather
 * than silently downgrading a recoverable overflow to "unknown" in production.
 */
for (const message of [
  "400 prompt is too long: 213451 tokens > 200000 maximum",
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 131204 tokens.",
]) {
  test(`Pi still recognises a real overflow: ${message.slice(0, 40)}…`, () => {
    assert.equal(isOverflowMessage(message), true);
    assert.equal(classifyTurnFailure({ message, overflowHint: true }).category, "context_overflow");
  });
}

test("throttling that mentions token limits is not an overflow", () => {
  // The reason this is Pi's job: the texts that look like an overflow but are
  // rate limiting are exactly what a hand-rolled pattern list gets wrong.
  assert.equal(
    isOverflowMessage("429 Request too large for gpt-4: rate limit reached for tokens"),
    false,
  );
});
