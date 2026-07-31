import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";
import { replaceSessionMessages } from "../services/session-store.ts";
import { createSession, userMessage } from "../test-support.ts";
import { createSessionRoutes } from "./sessions.ts";

migrate();

const jsonHeaders = { "content-type": "application/json" };

test("active-run lease rejects every session mutation and exposes run authority", async () => {
  const fixture = createSession();
  replaceSessionMessages(fixture.sessionId, [userMessage("original")]);
  const app = createTestApp(fixture.userId);
  const run = createActiveAgentRun({
    runId: `run_lease_${fixture.sessionId}`,
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });

  const mutations = [
    { method: "PATCH", path: `/sessions/${fixture.sessionId}`, body: { title: "blocked" } },
    { method: "POST", path: `/sessions/${fixture.sessionId}/fork`, body: { messageIndex: 0 } },
    {
      method: "POST",
      path: `/sessions/${fixture.sessionId}/messages/truncate`,
      body: { messageIndex: 0 },
    },
    {
      method: "PATCH",
      path: `/sessions/${fixture.sessionId}/messages/0`,
      body: { content: "blocked edit" },
    },
    { method: "DELETE", path: `/sessions/${fixture.sessionId}` },
  ] as const;

  try {
    for (const mutation of mutations) {
      const response = await app.request(mutation.path, {
        method: mutation.method,
        headers: jsonHeaders,
        body: "body" in mutation ? JSON.stringify(mutation.body) : undefined,
      });
      assert.equal(response.status, 409, `${mutation.method} ${mutation.path}`);
      assert.equal(response.headers.get("x-agent-run-id"), run.runId);
      const payload = await response.json() as { activeRun?: { runId?: string } };
      assert.equal(payload.activeRun?.runId, run.runId);
    }

    const stored = db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get();
    assert.equal(stored?.title, "Test");
    assert.equal(stored?.revision, 0);
  } finally {
    finishAgentRun(run);
  }

  const allowed = await app.request(`/sessions/${fixture.sessionId}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ title: "allowed" }),
  });
  assert.equal(allowed.status, 200);
  const saved = await allowed.json() as { title: string; revision: number };
  assert.equal(saved.title, "allowed");
  assert.equal(saved.revision, 1);
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
