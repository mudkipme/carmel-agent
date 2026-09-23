import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { agents, sessions, users } from "../db/schema.ts";
import { id } from "../db/seed.ts";
import { createActiveAgentRun, emitRunEvent, finishAgentRun } from "../runtime/run-stream.ts";
import { replacePiSessionMessages } from "../services/pi-session-storage.ts";
import { createSession, createUser, userMessage } from "../test-support.ts";
import { readSessionConnection } from "../services/session-snapshot.ts";
import { createAgentRunRoutes } from "./agent-runs.ts";

migrate();

test("active session list includes only running listed sessions owned by the caller", async () => {
  const fixture = createSession();
  const otherUserId = createUser();
  db.update(agents).set({ shared: true }).where(eq(agents.id, fixture.agentId)).run();
  const hiddenSessionId = id("session");
  const otherSessionId = id("session");
  const base = {
    title: "Test",
    agentId: fixture.agentId,
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off" as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.insert(sessions).values([
    { ...base, id: hiddenSessionId, userId: fixture.userId, archivedAt: Date.now() },
    { ...base, id: otherSessionId, userId: otherUserId },
  ]).run();
  const runs = [
    [fixture.sessionId, fixture.userId],
    [hiddenSessionId, fixture.userId],
    [otherSessionId, otherUserId],
  ].map(([sessionId, userId]) => createActiveAgentRun({
    runId: id("run"), sessionId, userId, abort: () => {},
  }));
  const user = db.select().from(users).where(eq(users.id, fixture.userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => { c.set("user", user); await next(); });
  app.route("/", createAgentRunRoutes());

  try {
    const active = await app.request(`/agents/${fixture.agentId}/active-sessions`);
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { sessionIds: [fixture.sessionId] });

    finishAgentRun(runs[0]!);
    const finished = await app.request(`/agents/${fixture.agentId}/active-sessions`);
    assert.deepEqual(await finished.json(), { sessionIds: [] });

    const anotherAgent = createSession({ userId: otherUserId });
    const denied = await app.request(`/agents/${anotherAgent.agentId}/active-sessions`);
    assert.equal(denied.status, 404);
  } finally {
    for (const run of runs) if (!run.finished) finishAgentRun(run);
  }
});

test("session connection snapshot is user-scoped and carries the active run", async () => {
  const fixture = createSession();
  await replacePiSessionMessages(fixture.sessionId, [userMessage("persisted before reconnect")]);
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

  await replacePiSessionMessages(fixture.sessionId, [userMessage("final authoritative message")]);
  finishAgentRun(run);

  const connection = await readSessionConnection(fixture.userId, fixture.sessionId);
  assert.equal(connection?.activeRun, null);
  assert.equal((connection?.session.messages[0] as { content?: unknown })?.content, "final authoritative message");
});

test("connection snapshots replace raw image data with the shared authenticated URL projection", async () => {
  const fixture = createSession();
  const rawImageData = "connection-raw-image-data";
  await replacePiSessionMessages(fixture.sessionId, [
    {
      role: "user",
      content: [{ type: "image", data: rawImageData, mimeType: "image/png" }],
    } as ReturnType<typeof userMessage>,
  ]);

  const connection = await readSessionConnection(fixture.userId, fixture.sessionId);
  const message = connection?.session.messages[0] as { content: unknown } | undefined;
  assert.deepEqual(message?.content, [
    {
      type: "image",
      mimeType: "image/png",
      url: `/api/sessions/${fixture.sessionId}/images/${connection?.session.messageEntryIds[0]}/0`,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(connection), new RegExp(rawImageData));
});
