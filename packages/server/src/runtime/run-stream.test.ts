import test from "node:test";
import assert from "node:assert/strict";
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
    emitRunEvent(run, { type: "agent_start" });
    emitRunEvent(run, { type: "turn_start" });
    assert.equal(getActiveAgentRunForSession(run.userId, run.sessionId)?.eventCursor, 2);

    const replay = createAgentRunEventStream(run.userId, run.runId, 1);
    assert.ok(replay);
    const firstReader = replay.body!.getReader();
    const first = await firstReader.read();
    assert.equal(parseEnvelope(first.value).sequence, 2);
    await firstReader.cancel();

    assert.equal(abortCalls, 0, "disconnecting an observer must not abort the run");
    emitRunEvent(run, { type: "agent_end", messages: [] });

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
    for (let index = 0; index < 1_001; index += 1) emitRunEvent(run, { type: "agent_start" });

    const response = createAgentRunEventStream(run.userId, run.runId, 0);
    assert.ok(response);
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("x-agent-event-cursor"), "1001");
    assert.match(await response.text(), /refresh the session connection/i);
  } finally {
    finishAgentRun(run);
  }
});

function parseEnvelope(value: Uint8Array | undefined): AgentRunEventEnvelope {
  assert.ok(value);
  return JSON.parse(new TextDecoder().decode(value).trim()) as AgentRunEventEnvelope;
}
