import test from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../db/index.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";
import { replaceSessionMessages } from "../services/session-store.ts";
import { createSession, userMessage } from "../test-support.ts";
import { readSessionConnection } from "./agent-runs.ts";

migrate();

test("session connection snapshot is user-scoped and carries the active run", () => {
  const fixture = createSession();
  replaceSessionMessages(fixture.sessionId, [userMessage("persisted before reconnect")]);
  const run = createActiveAgentRun({
    runId: "run_connection_active",
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });

  assert.equal(readSessionConnection("another_user", fixture.sessionId), undefined);
  const connection = readSessionConnection(fixture.userId, fixture.sessionId);
  assert.equal(connection?.activeRun?.runId, run.runId);
  assert.equal(connection?.session.messages.length, 1);

  finishAgentRun(run);
});

test("finished run snapshot returns the final persisted transcript with no stale run authority", () => {
  const fixture = createSession();
  const run = createActiveAgentRun({
    runId: "run_connection_finished",
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });

  replaceSessionMessages(fixture.sessionId, [userMessage("final authoritative message")]);
  finishAgentRun(run);

  const connection = readSessionConnection(fixture.userId, fixture.sessionId);
  assert.equal(connection?.activeRun, null);
  assert.deepEqual(connection?.session.messages, [userMessage("final authoritative message")]);
});
