import test from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../db/index.ts";
import { createActiveAgentRun, emitRunEvent, finishAgentRun } from "../runtime/run-stream.ts";
import { replaceSessionMessages } from "../services/session-store.ts";
import { createSession, userMessage } from "../test-support.ts";
import { readSessionConnection } from "./agent-runs.ts";

migrate();

test("session connection snapshot is user-scoped and carries the active run", async () => {
  const fixture = createSession();
  await replaceSessionMessages(fixture.sessionId, [userMessage("persisted before reconnect")]);
  const run = createActiveAgentRun({
    runId: "run_connection_active",
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });
  emitRunEvent(run, { type: "message_end", message: userMessage("persisted before reconnect") });

  assert.equal(await readSessionConnection("another_user", fixture.sessionId), undefined);
  const connection = await readSessionConnection(fixture.userId, fixture.sessionId);
  assert.equal(connection?.activeRun?.runId, run.runId);
  assert.equal(connection?.activeRun?.eventCursor, 1);
  assert.equal(connection?.session.messages.length, 1);

  finishAgentRun(run);
});

test("finished run snapshot returns the final persisted transcript with no stale run authority", async () => {
  const fixture = createSession();
  const run = createActiveAgentRun({
    runId: "run_connection_finished",
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });

  await replaceSessionMessages(fixture.sessionId, [userMessage("final authoritative message")]);
  finishAgentRun(run);

  const connection = await readSessionConnection(fixture.userId, fixture.sessionId);
  assert.equal(connection?.activeRun, null);
  assert.deepEqual(connection?.session.messages, [userMessage("final authoritative message")]);
});
