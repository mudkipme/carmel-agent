import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  abortAgentRun,
  createActiveAgentRun,
  agentRunSubscription,
  observeRunEvents,
  emitRunEvent,
  finishAgentRun,
  getActiveAgentRunForSession,
  sessionRunSnapshot,
  sessionRunVersion,
} from "./run-stream.ts";

test("run events are sequenced and reconnect replays only events after the cursor", async () => {
  let abortCalls = 0;
  const run = createActiveAgentRun({
    runId: "run_sequence",
    userId: "user_sequence",
    sessionId: "session_sequence",
    abort: () => {
      abortCalls += 1;
    },
  });
  try {
    emitRunEvent(run, { type: "turn_end" });
    emitRunEvent(run, {
      type: "live_update",
      ops: [["r", { tools: [{ callId: "call_1", name: "read", status: "running" }] }]],
    });
    assert.equal(getActiveAgentRunForSession(run.userId, run.sessionId)?.eventCursor, 2);

    const replay = agentRunSubscription(run.userId, run.runId, 1);
    assert.equal(replay.status, 200);
    const firstReader = observeRunEvents(run, 1).getReader();
    const first = await firstReader.read();
    assert.equal(first.value?.sequence, 2);
    await firstReader.cancel();

    assert.equal(abortCalls, 0, "disconnecting an observer must not abort the run");
    emitRunEvent(run, { type: "agent_end" });

    const resumed = agentRunSubscription(run.userId, run.runId, 2);
    assert.equal(resumed.status, 200);
    const resumedReader = observeRunEvents(run, 2).getReader();
    const next = await resumedReader.read();
    assert.equal(next.value?.sequence, 3);
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

    const response = agentRunSubscription(run.userId, run.runId, 0);
    assert.ok(response);
    assert.equal(response.status, 409);
  } finally {
    finishAgentRun(run);
  }
});

test("native batches are sequenced immediately and retain part ordering", () => {
  const run = createActiveAgentRun({
    runId: "native_batches",
    userId: "native_user",
    sessionId: "native_session",
    abort: () => {},
  });
  try {
    emitRunEvent(run, {
      type: "live_update",
      ops: [["r", { generation: { attempt: 1, message: assistantMessage() as never } }]],
    });
    const update = {
      type: "live_update" as const,
      ops: [
        [
          "s",
          ["generation", "message", "content"],
          [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "answer" },
          ],
        ],
      ] as import("@earendil-works/chord/delta").Op[],
    };
    emitRunEvent(run, update);
    assert.equal(run.nextSequence, 3);
    emitRunEvent(run, { type: "message_end", message: assistantMessage("answer") });
    assert.deepEqual(
      run.events.map((entry) => entry.event.type),
      ["live_update", "live_update", "message_end"],
    );
    assert.deepEqual(run.events[1]!.event, update);
  } finally {
    finishAgentRun(run);
  }
});

test("a run snapshot restores partial text and tools after their opening events leave the replay buffer", () => {
  const run = createActiveAgentRun({
    runId: "snapshot_run",
    userId: "snapshot_user",
    sessionId: "snapshot_session",
    abort: () => {},
  });
  try {
    const message = assistantMessage();
    assert.equal(message.role, "assistant");
    if (message.role !== "assistant") throw new Error("Expected assistant");
    emitRunEvent(run, {
      type: "live_update",
      ops: [
        [
          "r",
          {
            generation: {
              attempt: 1,
              message: { ...message, content: [{ type: "text", text: "" }] } as never,
            },
            tools: [{ callId: "pending", name: "read", status: "running" }],
            nestedTools: [
              {
                callId: "pending/c1",
                name: "bash",
                parentCallId: "pending",
                parentTaskId: 2,
                taskId: 3,
                arguments: {},
                status: "running",
                output: "progress",
              },
            ],
          },
        ],
      ],
    });
    for (let i = 0; i < 1001; i++)
      emitRunEvent(run, {
        type: "live_update",
        ops: [["a", ["generation", "message", "content", 0, "text"], "x"]],
      });
    assert.ok(run.events.every((event) => event.event.type === "live_update"));
    const snapshot = sessionRunSnapshot(run.userId, run.sessionId);
    assert.equal(snapshot.activeRun?.eventCursor, run.nextSequence - 1);
    const streaming = snapshot.runProgress?.live?.generation?.message;
    assert.ok(streaming?.role === "assistant");
    assert.deepEqual(streaming.content, [{ type: "text", text: "x".repeat(1001) }]);
    assert.deepEqual(
      snapshot.runProgress?.live?.tools
        ?.filter((call) => call.status !== "done")
        .map((call) => call.callId),
      ["pending"],
    );
    assert.equal(snapshot.runProgress?.live?.nestedTools?.[0]?.output, "progress");
    assert.equal(sessionRunSnapshot("another_user", run.sessionId).activeRun, null);
    emitRunEvent(run, { type: "live_update", ops: [["s", ["tools", 0, "status"], "done"]] });
    assert.deepEqual(
      sessionRunSnapshot(run.userId, run.sessionId)
        .runProgress?.live?.tools?.filter((call) => call.status !== "done")
        .map((call) => call.callId),
      [],
    );
  } finally {
    finishAgentRun(run);
  }
});

test("a run that starts and finishes between snapshot reads still changes the session version", () => {
  const sessionId = "short_lived_snapshot_session";
  const before = sessionRunVersion(sessionId);
  const run = createActiveAgentRun({
    runId: "short_lived_snapshot_run",
    userId: "snapshot_user",
    sessionId,
    abort: () => {},
  });
  finishAgentRun(run);
  assert.ok(sessionRunVersion(sessionId) > before);
  assert.equal(sessionRunSnapshot("snapshot_user", sessionId).activeRun, null);
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
