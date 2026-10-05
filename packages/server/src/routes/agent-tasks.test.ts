import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { agentTasks, users } from "../db/schema.ts";
import type { AgentTask } from "@carmel-agent/shared";
import { createAgent, createModelRef, createUser } from "../test-support.ts";
import { createAgentTaskRoutes } from "./agent-tasks.ts";

initialize();
const json = { "content-type": "application/json" };

test("a task is created, listed, paused, and deleted through its agent", async () => {
  const { userId, agentId } = fixture();
  const app = appAs(userId);

  const created = await app.request(`/agents/${agentId}/tasks`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Nightly", prompt: "Summarise.", scheduleKind: "cron", scheduleValue: "0 3 * * *", timezone: "UTC" }),
  });
  assert.equal(created.status, 201);
  const task = await created.json() as AgentTask;
  assert.equal(task.status, "active");

  const listed = await (await app.request(`/agents/${agentId}/tasks`)).json() as AgentTask[];
  assert.deepEqual(listed.map((entry) => entry.id), [task.id]);

  const paused = await app.request(`/agents/${agentId}/tasks/${task.id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify({ status: "paused" }),
  });
  assert.equal(((await paused.json()) as AgentTask).status, "paused");

  assert.equal((await app.request(`/agents/${agentId}/tasks/${task.id}`, { method: "DELETE" })).status, 200);
  assert.deepEqual(await (await app.request(`/agents/${agentId}/tasks`)).json(), []);
});

test("a bad schedule is rejected with 400 rather than stored", async () => {
  const { userId, agentId } = fixture();
  const response = await appAs(userId).request(`/agents/${agentId}/tasks`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Broken", prompt: "x", scheduleKind: "cron", scheduleValue: "not a cron" }),
  });
  assert.equal(response.status, 400);
  assert.equal(db.select().from(agentTasks).all().length, 0);
});

test("another user cannot see or reach tasks on an agent that is not theirs", async () => {
  const owner = fixture();
  const stranger = createUser();
  const app = appAs(owner.userId);
  const task = await (await app.request(`/agents/${owner.agentId}/tasks`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Private", prompt: "x", scheduleKind: "interval", scheduleValue: "60000" }),
  })).json() as AgentTask;

  const intruder = appAs(stranger);
  assert.equal((await intruder.request(`/agents/${owner.agentId}/tasks`)).status, 404);
  assert.equal(
    (await intruder.request(`/agents/${owner.agentId}/tasks/${task.id}`, { method: "DELETE" })).status,
    404,
  );
});

test("the run log is readable and empty until the task fires", async () => {
  const { userId, agentId } = fixture();
  const app = appAs(userId);
  const task = await (await app.request(`/agents/${agentId}/tasks`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Fresh", prompt: "x", scheduleKind: "interval", scheduleValue: "60000" }),
  })).json() as AgentTask;

  assert.deepEqual(await (await app.request(`/agents/${agentId}/tasks/${task.id}/runs`)).json(), []);
});

test("run now records a run without moving the schedule", async () => {
  // Trying a task by hand should not change when it next runs on its own.
  const { userId, agentId } = fixture();
  const app = appAs(userId);
  const task = await (await app.request(`/agents/${agentId}/tasks`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "Manual", prompt: "x", scheduleKind: "interval", scheduleValue: "3600000" }),
  })).json() as AgentTask;

  assert.equal((await app.request(`/agents/${agentId}/tasks/${task.id}/run`, { method: "POST" })).status, 200);

  const runs = await (await app.request(`/agents/${agentId}/tasks/${task.id}/runs`)).json() as unknown[];
  assert.equal(runs.length, 1);
  const stored = db.select().from(agentTasks).where(eq(agentTasks.id, task.id)).get()!;
  assert.equal(stored.nextRunAt, task.nextRunAt);
});

function fixture() {
  const userId = createUser();
  const modelRefId = createModelRef({ ownerUserId: userId });
  const agentId = createAgent({ ownerUserId: userId, defaultModelRefId: modelRefId });
  return { userId, agentId, modelRefId };
}

function appAs(userId: string) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createAgentTaskRoutes());
  return app;
}
