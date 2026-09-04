import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage, HarnessEvent } from "@earendil-works/pi-agent-core";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { applyStreamingEvent, isStreamingEvent, type AgentRunEvent } from "@carmel-agent/shared";
import { migrate } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { attachTestHarness } from "../effectors/testing/pi-harness.ts";
import { classifyTurnFailure } from "../effectors/failure-classifier.ts";
import { isOverflowMessage, projectRunEvent } from "./run-events.ts";

migrate();

test("streamed text and thinking are projected to deltas, not snapshots", () => {
  assert.deepEqual(
    projectRunEvent(messageUpdate({ type: "text_delta", contentIndex: 0, delta: "wor", partial: partial("Hello, wor") })),
    { type: "message_delta", contentIndex: 0, field: "text", delta: "wor" },
  );
  assert.deepEqual(
    projectRunEvent(messageUpdate({ type: "thinking_delta", contentIndex: 1, delta: "hm", partial: partial("") })),
    { type: "message_delta", contentIndex: 1, field: "thinking", delta: "hm" },
  );
});

test("events the client cannot use are dropped rather than forwarded", () => {
  // `partial` repeats the whole message; the deltas already carry the content.
  assert.equal(projectRunEvent(messageUpdate({ type: "text_start", contentIndex: 0, partial: partial("") })), undefined);
  assert.equal(
    projectRunEvent(messageUpdate({ type: "text_end", contentIndex: 0, content: "Hello", partial: partial("Hello") })),
    undefined,
  );
  assert.equal(projectRunEvent(laneEvent({ type: "run_start", runId: "run_1", startedAt: 1 })), undefined);
  assert.equal(projectRunEvent(laneEvent({ type: "turn_start", runId: "run_1", turnId: "turn_1" })), undefined);
  assert.equal(
    projectRunEvent(
      laneEvent({
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

test("tool calls arrive whole, without their streamed argument JSON", () => {
  const started = partial("");
  started.content = [{ type: "toolCall", id: "call_1", name: "read", arguments: {}, partialJson: "", index: 0 } as never];
  assert.deepEqual(
    projectRunEvent(messageUpdate({ type: "toolcall_start", contentIndex: 0, partial: started })),
    { type: "message_part", contentIndex: 0, part: { type: "toolCall", id: "call_1", name: "read", arguments: {} } },
  );

  // Partial JSON needs Pi's salvage parser to read, so it never goes on the wire.
  assert.equal(
    projectRunEvent(messageUpdate({ type: "toolcall_delta", contentIndex: 0, delta: '{"pa', partial: started })),
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
  assert.deepEqual(projectRunEvent(laneEvent({ type: "message_start", message: assistant })), {
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
  assert.equal(projectRunEvent(laneEvent({ type: "message_start", message: toolResult })), undefined);
  assert.deepEqual(projectRunEvent(laneEvent({ type: "message_end", message: toolResult })), {
    type: "message_end",
    message: toolResult,
  });
});

test("bulk payloads are stripped from lifecycle events", () => {
  assert.deepEqual(
    projectRunEvent(laneEvent({ type: "tool_start", runId: "run_1", turnId: "turn_1", toolCallId: "call_1", toolName: "write", args: { content: "x".repeat(50_000) } })),
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "write" },
  );
  assert.deepEqual(
    projectRunEvent(laneEvent({ type: "tool_end", runId: "run_1", turnId: "turn_1", toolCallId: "call_1", toolName: "write", result: { content: [{ type: "text", text: "x".repeat(50_000) }] }, isError: false, terminate: false })),
    { type: "tool_execution_end", toolCallId: "call_1", toolName: "write", isError: false },
  );
  assert.deepEqual(
    projectRunEvent(laneEvent({ type: "run_end", runId: "run_1", status: "completed", fromTipId: null, tipId: "e1", endedAt: 1 })),
    { type: "agent_end" },
  );
});

test("turn_end carries only the error the client renders", () => {
  assert.deepEqual(projectRunEvent(laneEvent({ type: "turn_end", runId: "run_1", turnId: "turn_1", message: assistantMessage(), toolResults: [] })), {
    type: "turn_end",
  });
  const failed = assistantMessage();
  failed.errorMessage = "Provider failed";
  assert.deepEqual(projectRunEvent(laneEvent({ type: "turn_end", runId: "run_1", turnId: "turn_1", message: failed, toolResults: [] })), {
    type: "turn_end",
    errorMessage: "Provider failed",
  });
});

test("a real streamed turn reassembles byte-for-byte from the projected events", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({ provider: `faux-stream-${crypto.randomUUID()}`, tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("weighing the options"), fauxText("Hello, world. ".repeat(40))]),
  ]);

  const piSession = await openPiSession(sessionId);
  const pi = await attachTestHarness(piSession, { models, model: faux.getModel(), systemPrompt: "Test assistant" });
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
    final = (await pi.branch()).flatMap((entry) => (entry.type === "message" ? [entry.message] : [])).at(-1);
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
  assert.ok(projected.some((event) => event.type === "message_delta"), "the turn must actually have streamed");
  assert.deepEqual((streaming as AssistantMessage | undefined)?.content, (final as AssistantMessage).content);

  // Guard the property this protocol exists for: no event may carry a snapshot
  // of the message-so-far, so the stream stays linear in the reply length.
  const wireBytes = projected.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
  assert.ok(
    wireBytes * 10 < rawBytes,
    `projected stream should be an order of magnitude smaller than Pi's events (${wireBytes} vs ${rawBytes} bytes)`,
  );
});

/** 0.85 renamed the payload's `assistantMessageEvent` field to plain `event`. */
function messageUpdate(event: unknown): HarnessEvent {
  return laneEvent({ type: "message_update", runId: "run_1", message: assistantMessage(), event });
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

/**
 * Wrap a payload as the harness delivers it.
 *
 * 0.85 events are a payload plus an envelope: everything scoped to a lane
 * carries its name. The projector never reads it, but the union does not admit
 * a bare payload, so the tests build the same shape the bus emits.
 */
function laneEvent(payload: { type: HarnessEvent["type"] } & Record<string, unknown>): HarnessEvent {
  return { ...payload, lane: "main" } as unknown as HarnessEvent;
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
  assert.equal(isOverflowMessage("429 Request too large for gpt-4: rate limit reached for tokens"), false);
});
