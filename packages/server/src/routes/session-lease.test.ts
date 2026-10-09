import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";
import { loadSession } from "../services/session-store.ts";
import { replacePiSessionMessages } from "../services/pi-session-storage.ts";
import { createSession, userMessage } from "../test-support.ts";
import { createSessionRoutes } from "./sessions.ts";
import { serializeSession } from "../serializers.ts";

initialize();

const jsonHeaders = { "content-type": "application/json" };

test("active-run lease rejects every session mutation and exposes run authority", async () => {
  const fixture = createSession();
  await replacePiSessionMessages(fixture.sessionId, [userMessage("original")]);
  const storedSession = await loadSession(fixture.sessionId);
  const entryId = storedSession?.messageEntryIds[0];
  assert.ok(entryId);
  const app = createTestApp(fixture.userId);
  const run = createActiveAgentRun({
    runId: `run_lease_${fixture.sessionId}`,
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });

  const mutations = [
    { method: "PATCH", path: `/sessions/${fixture.sessionId}`, body: { title: "blocked" } },
    { method: "POST", path: `/sessions/${fixture.sessionId}/fork`, body: { entryId } },
    {
      method: "POST",
      path: `/sessions/${fixture.sessionId}/messages/truncate`,
      body: { entryId },
    },
    {
      method: "PATCH",
      path: `/sessions/${fixture.sessionId}/messages/${encodeURIComponent(entryId)}`,
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
      const payload = (await response.json()) as { activeRun?: { runId?: string } };
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
  const saved = (await allowed.json()) as { title: string; revision: number };
  assert.equal(saved.title, "allowed");
  assert.equal(saved.revision, 1);
});

test("pinning and archiving go through during a run without staling its commit", async () => {
  const fixture = createSession();
  const app = createTestApp(fixture.userId);
  const run = createActiveAgentRun({
    runId: `run_placement_${fixture.sessionId}`,
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });

  try {
    const pinnedAt = Date.now();
    const pinned = await app.request(`/sessions/${fixture.sessionId}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ pinnedAt }),
    });
    assert.equal(pinned.status, 200);
    const archived = await app.request(`/sessions/${fixture.sessionId}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ archivedAt: pinnedAt }),
    });
    assert.equal(archived.status, 200);

    // Anything a run also writes still waits for it.
    const renamed = await app.request(`/sessions/${fixture.sessionId}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ title: "blocked", pinnedAt: null }),
    });
    assert.equal(renamed.status, 409);

    const stored = db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get();
    assert.equal(stored?.pinnedAt, pinnedAt);
    assert.equal(stored?.archivedAt, pinnedAt);
    assert.equal(stored?.title, "Test");
    // The run commits against the revision it started with; a bump here would
    // make it drop its model, thinking level and title.
    assert.equal(stored?.revision, 0);
  } finally {
    finishAgentRun(run);
  }
});

test("session images are addressed by entry, so an edit never reuses a cached URL", async () => {
  const fixture = createSession();
  const app = createTestApp(fixture.userId);
  const image = (data: string) =>
    ({ role: "user", content: [{ type: "image", data, mimeType: "image/png" }] }) as ReturnType<
      typeof userMessage
    >;
  const urlOf = (session: { messages: unknown[] }) =>
    (session.messages[0] as { content: Array<{ url: string }> }).content[0]!.url;

  await replacePiSessionMessages(fixture.sessionId, [
    image(Buffer.from("first").toString("base64")),
  ]);
  const before = (await loadSession(fixture.sessionId))!;
  const firstUrl = urlOf(serializeSession(before));
  assert.ok(firstUrl.includes(encodeURIComponent(before.messageEntryIds[0]!)));

  // The same position now holds a different image.
  await replacePiSessionMessages(fixture.sessionId, [
    image(Buffer.from("second").toString("base64")),
  ]);
  const secondUrl = urlOf(serializeSession((await loadSession(fixture.sessionId))!));
  assert.notEqual(secondUrl, firstUrl);

  const served = await app.request(secondUrl.replace(/^\/api/, ""));
  assert.equal(served.status, 200);
  assert.equal(await served.text(), "second");
  const missing = await app.request(`/sessions/${fixture.sessionId}/images/no-such-entry/0`);
  assert.equal(missing.status, 404);
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
