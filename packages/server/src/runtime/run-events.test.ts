import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "../effectors/pi-durable/index.ts";
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
import { isOverflowMessage, projectRunEvent, classifyAssistantFailure } from "./run-events.ts";

initialize();

test("native text/thinking batches pass through and rebuild every content part", () => {
  const event = {
    type: "message_update" as const,
    usage: assistantMessage().usage,
    changes: [
      { type: "thinking_delta" as const, contentIndex: 0, delta: "hm" },
      { type: "text_delta" as const, contentIndex: 1, delta: "Hello" },
    ],
  };
  const projected = projectRunEvent(event)!;
  assert.deepEqual(projected, event);
  assert.ok(isStreamingEvent(projected));
  const result = applyStreamingEvent(assistantMessage(), projected) as AssistantMessage;
  assert.deepEqual(result.content, [
    { type: "thinking", thinking: "hm" },
    { type: "text", text: "Hello" },
  ]);
  assert.equal(applyStreamingEvent(undefined, projected), undefined);
});

test("partial tool argument JSON is omitted and completed calls shed provider scratch fields", () => {
  const call = {
    type: "toolCall" as const,
    id: "c1",
    name: "read",
    arguments: { path: "file" },
    partialJson: "ignored",
    index: 1,
  };
  const event = {
    type: "message_update" as const,
    usage: assistantMessage().usage,
    changes: [
      { type: "toolcall_delta" as const, contentIndex: 0, path: ["path"], delta: "fil" },
      { type: "block" as const, contentIndex: 0, block: call },
    ],
  };
  assert.deepEqual(projectRunEvent(event), {
    type: "message_update",
    usage: event.usage,
    changes: [
      {
        type: "block",
        contentIndex: 0,
        block: { type: "toolCall", id: "c1", name: "read", arguments: { path: "file" } },
      },
    ],
  });
  assert.equal(projectRunEvent({ ...event, changes: [event.changes[0]!] }), undefined);
});

test("a native message replacement restores streamed state after a backlog gap", () => {
  const replacement = {
    ...assistantMessage(),
    content: [{ type: "text" as const, text: "replacement" }],
  };
  const event = {
    type: "message_update" as const,
    usage: replacement.usage,
    changes: [{ type: "message" as const, message: replacement }],
  };
  assert.deepEqual(applyStreamingEvent(undefined, event), replacement);
});

test("native transcript entries project once, with user/tool starts omitted", () => {
  const message = { role: "user", content: "question", timestamp: 1 } as const;
  assert.equal(projectRunEvent({ type: "message_start", message }), undefined);
  const tool = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "read",
    content: [{ type: "text", text: "output" }],
    isError: false,
    timestamp: 1,
  } as const;
  assert.deepEqual(
    projectRunEvent({
      type: "message_end",
      entry: { id: 1, kind: "pi.tool-result", model: [tool] } as never,
    }),
    { type: "message_end", message: tool },
  );
});

test("native nested snapshots and output progress retain their native shape", () => {
  const tools = [
    {
      callId: "parent/c1",
      name: "read",
      status: "running",
      taskId: 2,
      parentTaskId: 1,
      parentCallId: "parent",
      arguments: {},
    },
  ];
  assert.deepEqual(projectRunEvent({ type: "snapshot", nestedTools: tools } as never), {
    type: "nested_tools",
    tools,
  });
  const event = {
    type: "tool_execution_update" as const,
    toolCallId: "parent/c1",
    toolName: "read",
    parentToolCallId: "parent",
    output: { trimStart: 2, append: "next" },
    details: { progress: 1 },
    diagnostics: [],
  };
  assert.deepEqual(projectRunEvent(event), event);
  assert.equal(projectRunEvent({ ...event, parentToolCallId: undefined }), undefined);
});

test("native completion summaries omit duplicate result bodies", () => {
  const start = {
    type: "tool_execution_start" as const,
    toolCallId: "c1",
    toolName: "write",
    args: { content: "large" },
  };
  assert.deepEqual(projectRunEvent(start), start);
  assert.deepEqual(
    projectRunEvent({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "write",
      entry: { data: "large" } as never,
    }),
    { type: "tool_execution_end", toolCallId: "c1", toolName: "write" },
  );
  assert.deepEqual(
    projectRunEvent({
      type: "tool_execution_end",
      toolCallId: "parent/c1",
      toolName: "read",
      result: {
        taskId: 2 as never,
        isError: false,
        diagnostics: [],
        durationMs: 4,
        structuredOutput: "large",
      },
    }),
    {
      type: "tool_execution_end",
      toolCallId: "parent/c1",
      toolName: "read",
      result: { taskId: 2 as never, isError: false, diagnostics: [], durationMs: 4 },
    },
  );
});

test("native turn-end uses the committed assistant's classified error", () => {
  assert.deepEqual(projectRunEvent({ type: "turn_end" }), { type: "turn_end" });
  const failed = {
    ...assistantMessage(),
    errorMessage: "Provider failed",
    stopReason: "error" as const,
  };
  assert.deepEqual(projectRunEvent({ type: "turn_end" }, classifyAssistantFailure(failed)), {
    type: "turn_end",
    errorMessage: "Provider failed",
  });
  const overran = assistantMessage();
  overran.usage = { ...overran.usage, input: 9000, totalTokens: 9000 };
  const projected = projectRunEvent({ type: "turn_end" }, classifyAssistantFailure(overran, 8192));
  assert.ok(projected?.type === "turn_end" && projected.errorMessage);
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
    else if (event.type === "message_end" && event.message.role === "assistant")
      streaming = event.message;
  }

  assert.ok(final && final.role === "assistant");
  assert.ok(
    projected.some((event) => event.type === "message_update"),
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
