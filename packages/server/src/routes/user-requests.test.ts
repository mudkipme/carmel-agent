import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { users, sessions } from "../db/schema.ts";
import { createSession, createUser } from "../test-support.ts";
import type { AuthVariables } from "../auth.ts";
import { questionInputSchema, secretRequestInputSchema } from "@carmel-agent/shared";
import {
  createUserRequest,
  pendingUserReply,
  readUserRequests,
} from "../services/user-requests.ts";
import { withPiSession } from "../services/pi-session-storage.ts";
import { createUserRequestRoutes } from "./user-requests.ts";
import { createSessionRoutes } from "./sessions.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";

initialize();
function appFor(userId: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", db.select().from(users).where(eq(users.id, userId)).get()!);
    await next();
  });
  app.route("/", createUserRequestRoutes());
  app.route("/", createSessionRoutes());
  return app;
}
function post(app: ReturnType<typeof appFor>, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("secret submission is a separate owner-only endpoint and never echoes validation input", async () => {
  const previous = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = "route-test-encryption-key";
  try {
    const fixture = createSession();
    const request = await withPiSession(fixture.sessionId, async (pi) =>
      createUserRequest(
        {
          sessionId: fixture.sessionId,
          conversationId: String(pi.conversation.id),
          callId: "secret",
        },
        "secret",
        secretRequestInputSchema.parse({ name: "GITHUB_TOKEN", reason: "Use GitHub" }),
      ),
    );
    const path = `/sessions/${fixture.sessionId}/requests/${request.id}`;
    const app = appFor(fixture.userId);
    const secret = "ghp_private_route_test_value";
    assert.equal(
      (await post(appFor(createUser()), `${path}/secret`, { value: secret })).status,
      404,
    );
    assert.equal((await post(app, `${path}/answer`, { value: secret })).status, 400);
    const invalid = await post(app, `${path}/secret`, { value: secret, extra: secret });
    assert.equal(invalid.status, 400);
    assert.ok(!(await invalid.text()).includes(secret));
    const run = createActiveAgentRun({
      runId: crypto.randomUUID(),
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      abort() {},
    });
    assert.equal((await post(app, `${path}/secret`, { value: secret })).status, 409);
    finishAgentRun(run);
    const response = await post(app, `${path}/secret`, { value: secret });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const safe = await response.json();
    assert.ok(!JSON.stringify(safe).includes(secret));
    assert.equal((safe as { credential: { scope: string } }).credential.scope, "session");
    assert.ok(!JSON.stringify(readUserRequests(fixture.sessionId)).includes(secret));
    assert.ok(!pendingUserReply(fixture.sessionId)!.text.includes(secret));
    const duplicate = await post(app, `${path}/secret`, { value: "a different retry" });
    assert.deepEqual(await duplicate.json(), safe);
    const listing = await app.request(`/sessions/${fixture.sessionId}/secrets`);
    assert.ok(!(await listing.text()).includes(secret));
  } finally {
    if (previous === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previous;
  }
});

test("question answers are validated and transcript mutations cannot orphan a pending request", async () => {
  const fixture = createSession();
  const request = await withPiSession(fixture.sessionId, async (pi) =>
    createUserRequest(
      {
        sessionId: fixture.sessionId,
        conversationId: String(pi.conversation.id),
        callId: "question",
      },
      "question",
      questionInputSchema.parse({
        question: "Select environments",
        options: [
          { id: "dev", label: "Development" },
          { id: "prod", label: "Production" },
        ],
        multiple: true,
        allowFreeText: false,
      }),
    ),
  );
  const app = appFor(fixture.userId);
  const path = `/sessions/${fixture.sessionId}/requests/${request.id}`;
  assert.equal(
    (await post(app, `/sessions/${fixture.sessionId}/fork`, { entryId: "durable:1" })).status,
    409,
  );
  assert.equal((await post(app, `${path}/answer`, { selected: ["not-an-option"] })).status, 400);
  const response = await post(app, `${path}/answer`, { selected: ["dev", "prod"] });
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as { answer: unknown }).answer, {
    selected: ["dev", "prod"],
    text: "",
  });
});

test("request responses cannot target another branch and session deletion cascades requests", async () => {
  const fixture = createSession();
  const request = createUserRequest(
    { sessionId: fixture.sessionId, conversationId: "wrong-branch", callId: "q" },
    "question",
    questionInputSchema.parse({ question: "Old branch?" }),
  );
  const app = appFor(fixture.userId);
  assert.equal(
    (
      await post(app, `/sessions/${fixture.sessionId}/requests/${request.id}/answer`, {
        text: "ignored",
      })
    ).status,
    409,
  );
  db.delete(sessions).where(eq(sessions.id, fixture.sessionId)).run();
  assert.equal(readUserRequests(fixture.sessionId).length, 0);
});
