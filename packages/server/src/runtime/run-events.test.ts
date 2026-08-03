import test from "node:test";
import assert from "node:assert/strict";
import { AgentHarness, type AgentHarnessEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { applyStreamingEvent, isStreamingEvent, type AgentRunEvent } from "@carmel-agent/shared";
import { migrate } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { closePiSession, openPiSession } from "../services/pi-session-storage.ts";
import { projectRunEvent } from "./run-events.ts";

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
  assert.equal(projectRunEvent({ type: "agent_start" } as AgentHarnessEvent), undefined);
  assert.equal(projectRunEvent({ type: "turn_start" } as AgentHarnessEvent), undefined);
  assert.equal(
    projectRunEvent({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      args: {},
      partialResult: { output: "x".repeat(100_000) },
    } as AgentHarnessEvent),
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
  assert.deepEqual(projectRunEvent({ type: "message_start", message: assistant }), {
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
  assert.equal(projectRunEvent({ type: "message_start", message: toolResult }), undefined);
  assert.deepEqual(projectRunEvent({ type: "message_end", message: toolResult }), {
    type: "message_end",
    message: toolResult,
  });
});

test("bulk payloads are stripped from lifecycle events", () => {
  assert.deepEqual(
    projectRunEvent({ type: "tool_execution_start", toolCallId: "call_1", toolName: "write", args: { content: "x".repeat(50_000) } }),
    { type: "tool_execution_start", toolCallId: "call_1", toolName: "write" },
  );
  assert.deepEqual(
    projectRunEvent({ type: "tool_execution_end", toolCallId: "call_1", toolName: "write", result: { output: "x".repeat(50_000) }, isError: false }),
    { type: "tool_execution_end", toolCallId: "call_1", toolName: "write", isError: false },
  );
  assert.deepEqual(projectRunEvent({ type: "agent_end", messages: [assistantMessage(), assistantMessage()] }), {
    type: "agent_end",
  });
});

test("turn_end carries only the error the client renders", () => {
  assert.deepEqual(projectRunEvent({ type: "turn_end", message: assistantMessage(), toolResults: [] }), {
    type: "turn_end",
  });
  const failed = assistantMessage();
  failed.errorMessage = "Provider failed";
  assert.deepEqual(projectRunEvent({ type: "turn_end", message: failed, toolResults: [] }), {
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
  const harness = new AgentHarness({ session: piSession, models, model: faux.getModel(), systemPrompt: "Test assistant" });
  const projected: AgentRunEvent[] = [];
  let rawBytes = 0;
  const unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
    rawBytes += Buffer.byteLength(JSON.stringify(event));
    const wireEvent = projectRunEvent(event);
    if (wireEvent) projected.push(wireEvent);
  });

  let final: AgentMessage | undefined;
  try {
    await harness.prompt("hello");
    final = (await piSession.getBranch()).flatMap((entry) => (entry.type === "message" ? [entry.message] : [])).at(-1);
  } finally {
    unsubscribe();
    await closePiSession(piSession);
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

function messageUpdate(assistantMessageEvent: unknown): AgentHarnessEvent {
  return { type: "message_update", message: assistantMessage(), assistantMessageEvent } as AgentHarnessEvent;
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
