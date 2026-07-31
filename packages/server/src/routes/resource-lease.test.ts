import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";
import { createAgent, createModelRef, createProviderConfig, createUser } from "../test-support.ts";
import { createAgentRoutes } from "./agents.ts";
import { createModelRoutes } from "./models.ts";
import { createProviderConfigRoutes } from "./provider-configs.ts";
import { createUserRoutes } from "./users.ts";

migrate();

test("active-run lease blocks cascading agent, model, provider, and user deletion", async () => {
  const ownerId = createUser();
  db.update(users).set({ role: "admin" }).where(eq(users.id, ownerId)).run();
  const providerConfigId = createProviderConfig(ownerId);
  const modelRefId = createModelRef({ ownerUserId: ownerId, providerConfigId });
  const agentId = createAgent({ ownerUserId: ownerId, defaultModelRefId: modelRefId });
  const sessionId = id("session");
  const timestamp = now();
  db.insert(sessions)
    .values({
      id: sessionId,
      title: "Leased",
      userId: ownerId,
      agentId,
      modelRefId,
      thinkingLevel: "off",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();

  const actingAdminId = createUser();
  db.update(users).set({ role: "admin" }).where(eq(users.id, actingAdminId)).run();
  const run = createActiveAgentRun({
    runId: `run_resources_${sessionId}`,
    userId: ownerId,
    sessionId,
    abort: () => {},
  });

  const attempts = [
    { app: createTestApp(ownerId, createAgentRoutes), path: `/agents/${agentId}` },
    { app: createTestApp(ownerId, createModelRoutes), path: `/models/${modelRefId}` },
    { app: createTestApp(ownerId, createProviderConfigRoutes), path: `/provider-configs/${providerConfigId}` },
    { app: createTestApp(actingAdminId, createUserRoutes), path: `/users/${ownerId}` },
  ];

  try {
    for (const attempt of attempts) {
      const response = await attempt.app.request(attempt.path, { method: "DELETE" });
      assert.equal(response.status, 409, attempt.path);
      assert.equal(response.headers.get("x-agent-run-id"), run.runId);
    }
    assert.ok(db.select().from(sessions).where(eq(sessions.id, sessionId)).get());
  } finally {
    finishAgentRun(run);
  }
});

function createTestApp(
  userId: string,
  createRoutes: () => Hono<{ Variables: AuthVariables }>,
) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createRoutes());
  return app;
}
