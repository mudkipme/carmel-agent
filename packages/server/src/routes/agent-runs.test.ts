import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { agents, sessions, users } from "../db/schema.ts";
import { id } from "../db/seed.ts";
import { createActiveAgentRun, emitRunEvent, finishAgentRun } from "../runtime/run-stream.ts";
import { replacePiSessionMessages, withPiSession } from "../services/pi-session-storage.ts";
import { createSession, createUser, userMessage } from "../test-support.ts";
import { readSessionConnection, SessionSnapshotError } from "../services/session-snapshot.ts";
import { createAgentRunRoutes } from "./agent-runs.ts";

initialize();

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
  db.insert(sessions)
    .values([
      { ...base, id: hiddenSessionId, userId: fixture.userId, archivedAt: Date.now() },
      { ...base, id: otherSessionId, userId: otherUserId },
    ])
    .run();
  const runs = [
    [fixture.sessionId, fixture.userId],
    [hiddenSessionId, fixture.userId],
    [otherSessionId, otherUserId],
  ].map(([sessionId, userId]) =>
    createActiveAgentRun({
      runId: id("run"),
      sessionId,
      userId,
      abort: () => {},
    }),
  );
  const user = db.select().from(users).where(eq(users.id, fixture.userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createAgentRunRoutes());

  try {
    const active = await app.request(`/agents/${fixture.agentId}/active-sessions`);
    assert.equal(active.status, 200);
    assert.deepEqual(await active.json(), { sessionIds: [fixture.sessionId] });
    const removedStream = await app.request(`/agent-runs/${runs[0]!.runId}/events`);
    assert.equal(removedStream.status, 404);

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
  assert.equal(
    (connection?.session.messages[0] as { content?: unknown })?.content,
    "final authoritative message",
  );
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
      url: `/api/sessions/${fixture.sessionId}/images/${encodeURIComponent(connection!.session.messageEntryIds[0]!)}/0`,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(connection), new RegExp(rawImageData));
});

test("connection snapshot retries refresh session metadata and exhaustion fails rather than skewing", async () => {
  const fixture = createSession();
  await replacePiSessionMessages(fixture.sessionId, [userMessage("message 1")]);
  const run = createActiveAgentRun({
    runId: id("run"),
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });

  try {
    await withPiSession(fixture.sessionId, async (pi) => {
      let releaseCommit!: () => void;
      const enteredCommit = new Promise<void>((resolveEntered) => {
        void pi.conversation.commit(async () => {
          resolveEntered();
          await new Promise<void>((resolveRelease) => {
            releaseCommit = resolveRelease;
          });
        }, BACKGROUND_CONTEXT);
      });

      await enteredCommit;
      const retriedPromise = readSessionConnection(fixture.userId, fixture.sessionId);
      // Let readSessionConnection capture version 1 and queue behind our active commit.
      await new Promise((resolve) => setTimeout(resolve, 10));

      db.update(sessions)
        .set({ title: "Updated after run finished", thinkingLevel: "high" })
        .where(eq(sessions.id, fixture.sessionId))
        .run();
      finishAgentRun(run);
      releaseCommit();

      const retried = await retriedPromise;
      assert.equal(retried?.activeRun, null);
      assert.equal(retried?.session.title, "Updated after run finished");
      assert.equal(retried?.session.thinkingLevel, "high");

      const busyRun = createActiveAgentRun({
        runId: id("run"),
        userId: fixture.userId,
        sessionId: fixture.sessionId,
        abort: () => {},
      });
      try {
        let releaseExhaustion!: () => void;
        const enteredExhaustion = new Promise<void>((resolveEntered) => {
          void pi.conversation.commit(async () => {
            resolveEntered();
            await new Promise<void>((resolveRelease) => {
              releaseExhaustion = resolveRelease;
            });
          }, BACKGROUND_CONTEXT);
        });

        await enteredExhaustion;
        const exhaustedPromise = readSessionConnection(fixture.userId, fixture.sessionId, 1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        emitRunEvent(busyRun, { type: "message_end", message: userMessage("message 2") });
        releaseExhaustion();

        await assert.rejects(
          () => exhaustedPromise,
          (error: unknown) => error instanceof SessionSnapshotError && error.status === 503,
        );
      } finally {
        finishAgentRun(busyRun);
      }
    });
  } finally {
    if (!run.finished) finishAgentRun(run);
  }
});

test("connection route maps SessionSnapshotError to 503 on real connection retries", async () => {
  const fixture = createSession();
  const user = db.select().from(users).where(eq(users.id, fixture.userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createAgentRunRoutes());

  const run = createActiveAgentRun({
    runId: id("run"),
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });

  try {
    await withPiSession(fixture.sessionId, async (pi) => {
      const originalCommit = pi.conversation.commit.bind(pi.conversation);
      pi.conversation.commit = ((fn, ctx) => {
        emitRunEvent(run, {
          type: "message_end",
          message: userMessage("concurrent update"),
        });
        return originalCommit(fn, ctx);
      }) as typeof pi.conversation.commit;

      try {
        const response = await app.request(`/sessions/${fixture.sessionId}/connection`);
        assert.equal(response.status, 503);
      } finally {
        pi.conversation.commit = originalCommit;
      }
    });
  } finally {
    finishAgentRun(run);
  }
});
