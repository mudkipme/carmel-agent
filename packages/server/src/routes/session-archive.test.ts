import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { SessionMetadata } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { createAgent, createModelRef, createSession, createUser } from "../test-support.ts";
import { createSessionRoutes } from "./sessions.ts";

initialize();

const jsonHeaders = { "content-type": "application/json" };

test("archived sessions leave bootstrap and are listed per agent until restored", async () => {
  const fixture = createSession();
  const app = createTestApp(fixture.userId);
  const before = db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get();
  assert.ok(before);

  const archivedAt = Date.now();
  const archive = await app.request(`/sessions/${fixture.sessionId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ archivedAt }),
  });
  assert.equal(archive.status, 200);
  const archivedSession = await archive.json() as SessionMetadata;
  assert.equal(archivedSession.archivedAt, archivedAt);
  // Archiving is a preference, like pinning: it must not reorder by activity.
  assert.equal(archivedSession.updatedAt, before.updatedAt);

  assert.ok(!readBootstrapPayload(fixture.userId).sessions.some((session) => session.id === fixture.sessionId));
  const listed = await app.request(`/agents/${fixture.agentId}/archived-sessions`);
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json() as SessionMetadata[]).map((session) => session.id), [fixture.sessionId]);

  const restore = await app.request(`/sessions/${fixture.sessionId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ archivedAt: null }),
  });
  assert.equal(restore.status, 200);
  assert.equal((await restore.json() as SessionMetadata).archivedAt, undefined);
  assert.ok(readBootstrapPayload(fixture.userId).sessions.some((session) => session.id === fixture.sessionId));
  const relisted = await app.request(`/agents/${fixture.agentId}/archived-sessions`);
  assert.deepEqual(await relisted.json(), []);
});

test("archived session listing is scoped to the caller and to visible agents", async () => {
  const fixture = createSession();
  db.update(sessions).set({ archivedAt: Date.now() }).where(eq(sessions.id, fixture.sessionId)).run();

  const stranger = createUser();
  const response = await createTestApp(stranger).request(`/agents/${fixture.agentId}/archived-sessions`);
  assert.equal(response.status, 404);
});

test("users of a shared agent see only their own archived sessions", async () => {
  const owner = createUser();
  const modelRefId = createModelRef({ ownerUserId: owner, shared: true });
  const agentId = createAgent({ ownerUserId: owner, shared: true, defaultModelRefId: modelRefId });
  const guest = createUser();
  const archiveSessionFor = (userId: string) => {
    const sessionId = id("session");
    const timestamp = now();
    db.insert(sessions)
      .values({ id: sessionId, title: "Test", userId, agentId, modelRefId, thinkingLevel: "off", archivedAt: timestamp, createdAt: timestamp, updatedAt: timestamp })
      .run();
    return sessionId;
  };
  archiveSessionFor(owner);
  const guestSessionId = archiveSessionFor(guest);

  const response = await createTestApp(guest).request(`/agents/${agentId}/archived-sessions`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as SessionMetadata[]).map((session) => session.id), [guestSessionId]);
});

test("a task run's session joins the session list only once moved there", async () => {
  const fixture = createSession();
  db.update(sessions).set({ taskId: "agent_task_test" }).where(eq(sessions.id, fixture.sessionId)).run();
  const listed = () => readBootstrapPayload(fixture.userId).sessions.some((session) => session.id === fixture.sessionId);
  assert.equal(listed(), false);

  const app = createTestApp(fixture.userId);
  const move = await app.request(`/sessions/${fixture.sessionId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ taskId: null }),
  });
  assert.equal(move.status, 200);
  assert.equal((await move.json() as SessionMetadata).taskId, undefined);
  assert.equal(listed(), true);

  // The id can only be cleared: a session cannot be attached to a task from outside.
  const attach = await app.request(`/sessions/${fixture.sessionId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ taskId: "agent_task_test" }),
  });
  assert.equal(attach.status, 400);
});

function createTestApp(userId: string) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createSessionRoutes());
  return app;
}
