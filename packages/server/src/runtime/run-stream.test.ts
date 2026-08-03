import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRunEventEnvelope } from "@carmel-agent/shared";
import {
  abortAgentRun,
  createActiveAgentRun,
  createAgentRunEventStream,
  emitRunEvent,
  finishAgentRun,
  getActiveAgentRunForSession,
} from "./run-stream.ts";

test("run events are sequenced and reconnect replays only events after the cursor", async () => {
  let abortCalls = 0;
  const run = createActiveAgentRun({
    runId: "run_sequence",
    userId: "user_sequence",
    sessionId: "session_sequence",
    abort: () => { abortCalls += 1; },
  });
  try {
    emitRunEvent(run, { type: "turn_end" });
    emitRunEvent(run, { type: "tool_execution_start", toolCallId: "call_1", toolName: "read" });
    assert.equal(getActiveAgentRunForSession(run.userId, run.sessionId)?.eventCursor, 2);

    const replay = createAgentRunEventStream(run.userId, run.runId, 1);
    assert.ok(replay);
    const firstReader = replay.body!.getReader();
    const first = await firstReader.read();
    assert.equal(parseEnvelope(first.value).sequence, 2);
    await firstReader.cancel();

    assert.equal(abortCalls, 0, "disconnecting an observer must not abort the run");
    emitRunEvent(run, { type: "agent_end" });

    const resumed = createAgentRunEventStream(run.userId, run.runId, 2);
    assert.ok(resumed);
    const resumedReader = resumed.body!.getReader();
    const next = await resumedReader.read();
    assert.equal(parseEnvelope(next.value).sequence, 3);
    await resumedReader.cancel();
    assert.equal(abortCalls, 0);

    assert.equal(abortAgentRun("other_user", run.runId), false);
    assert.equal(abortCalls, 0);
    assert.equal(abortAgentRun(run.userId, run.runId), true);
    assert.equal(abortCalls, 1, "only the explicit stop operation invokes abort");
  } finally {
    finishAgentRun(run);
  }
});

test("a replay buffer gap requires a fresh authoritative snapshot cursor", async () => {
  const run = createActiveAgentRun({
    runId: "run_gap",
    userId: "user_gap",
    sessionId: "session_gap",
    abort: () => {},
  });
  try {
    for (let index = 0; index < 1_001; index += 1) emitRunEvent(run, { type: "turn_end" });

    const response = createAgentRunEventStream(run.userId, run.runId, 0);
    assert.ok(response);
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("x-agent-event-cursor"), "1001");
    assert.match(await response.text(), /refresh the session connection/i);
  } finally {
    finishAgentRun(run);
  }
});

test("consecutive deltas for one content part are merged into a single event", async () => {
  const run = createActiveAgentRun({
    runId: "run_coalesce",
    userId: "user_coalesce",
    sessionId: "session_coalesce",
    abort: () => {},
  });
  try {
    emitRunEvent(run, { type: "message_start", message: assistantMessage() });
    for (const delta of ["Hel", "lo, ", "wor", "ld"]) {
      emitRunEvent(run, { type: "message_delta", contentIndex: 0, field: "text", delta });
    }
    assert.equal(run.nextSequence, 2, "buffered deltas must not consume sequence numbers yet");

    // A non-delta event flushes whatever is buffered ahead of itself.
    emitRunEvent(run, { type: "message_end", message: assistantMessage("Hello, world") });

    assert.deepEqual(run.events.map((entry) => entry.event.type), [
      "message_start",
      "message_delta",
      "message_end",
    ]);
    assert.deepEqual(run.events[1].event, {
      type: "message_delta",
      contentIndex: 0,
      field: "text",
      delta: "Hello, world",
    });
  } finally {
    finishAgentRun(run);
  }
});

test("deltas for different content parts stay separate and flush on their own timer", async () => {
  const run = createActiveAgentRun({
    runId: "run_parts",
    userId: "user_parts",
    sessionId: "session_parts",
    abort: () => {},
  });
  try {
    emitRunEvent(run, { type: "message_start", message: assistantMessage() });
    emitRunEvent(run, { type: "message_delta", contentIndex: 0, field: "thinking", delta: "hmm" });
    // A different part must not be appended onto the pending one.
    emitRunEvent(run, { type: "message_delta", contentIndex: 1, field: "text", delta: "answer" });

    await delay(120);

    assert.deepEqual(run.events.map((entry) => entry.event), [
      { type: "message_start", message: assistantMessage() },
      { type: "message_delta", contentIndex: 0, field: "thinking", delta: "hmm" },
      { type: "message_delta", contentIndex: 1, field: "text", delta: "answer" },
    ]);
  } finally {
    finishAgentRun(run);
  }
});

test("a client attaching mid-message rewinds to the message_start it needs to rebuild from", async () => {
  const run = createActiveAgentRun({
    runId: "run_attach",
    userId: "user_attach",
    sessionId: "session_attach",
    abort: () => {},
  });
  try {
    emitRunEvent(run, { type: "turn_end" });
    emitRunEvent(run, { type: "message_start", message: assistantMessage() });
    emitRunEvent(run, { type: "message_delta", contentIndex: 0, field: "text", delta: "partial" });
    emitRunEvent(run, { type: "tool_execution_start", toolCallId: "call_1", toolName: "read" });

    // message_start is sequence 2, so the cursor must sit just before it.
    assert.equal(getActiveAgentRunForSession(run.userId, run.sessionId)?.eventCursor, 1);
    const stream = createAgentRunEventStream(run.userId, run.runId, 1);
    assert.ok(stream);
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.equal(parseEnvelope((await reader.read()).value).event.type, "message_start");
    await reader.cancel();

    // Once the message is complete there is nothing to rebuild, so the cursor
    // returns to the newest event.
    emitRunEvent(run, { type: "message_end", message: assistantMessage("partial") });
    assert.equal(getActiveAgentRunForSession(run.userId, run.sessionId)?.eventCursor, run.nextSequence - 1);
  } finally {
    finishAgentRun(run);
  }
});

test("the attach cursor never rewinds past the replay buffer", async () => {
  const run = createActiveAgentRun({
    runId: "run_evicted",
    userId: "user_evicted",
    sessionId: "session_evicted",
    abort: () => {},
  });
  try {
    emitRunEvent(run, { type: "message_start", message: assistantMessage() });
    // Push the message_start out of the buffer with distinct, uncoalescable events.
    for (let index = 0; index < 1_100; index += 1) {
      emitRunEvent(run, { type: "tool_execution_start", toolCallId: `call_${index}`, toolName: "read" });
    }

    const cursor = getActiveAgentRunForSession(run.userId, run.sessionId)?.eventCursor;
    assert.ok(cursor !== undefined);
    // A cursor below the buffer would 409, and the 409 path resolves by asking
    // for this same cursor again -- so it has to be servable.
    const stream = createAgentRunEventStream(run.userId, run.runId, cursor);
    assert.ok(stream);
    assert.equal(stream.status, 200);
    await stream.body!.cancel();
  } finally {
    finishAgentRun(run);
  }
});

function assistantMessage(text = ""): AgentMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
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
  };
}

function parseEnvelope(value: Uint8Array | undefined): AgentRunEventEnvelope {
  assert.ok(value);
  return JSON.parse(new TextDecoder().decode(value).trim()) as AgentRunEventEnvelope;
}
