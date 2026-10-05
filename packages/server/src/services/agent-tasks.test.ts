import test from "node:test";
import assert from "node:assert/strict";
import { initialize } from "../db/index.ts";
import { createAgent, createModelRef, createUser } from "../test-support.ts";
import {
  AgentTaskError,
  createAgentTask,
  deleteAgentTask,
  deleteAgentTasksForAgent,
  readAgentTasks,
  readDueTasks,
  updateAgentTask,
} from "./agent-tasks.ts";

initialize();

test("a task is created armed with its next run", () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, draft({ scheduleKind: "interval", scheduleValue: String(60_000) }));
  assert.equal(task.status, "active");
  assert.ok(task.nextRunAt && task.nextRunAt > Date.now());
});

test("an unparseable schedule is rejected at write time", () => {
  // Otherwise it becomes a task that disables itself the first time it is due,
  // which the author is not present to see.
  const { user, agentId } = fixture();
  assert.throws(
    () => createAgentTask(user, agentId, draft({ scheduleKind: "cron", scheduleValue: "not a cron" })),
    (error: unknown) => error instanceof AgentTaskError && error.status === 400,
  );
});

test("a one-shot in the past is rejected rather than created already complete", () => {
  const { user, agentId } = fixture();
  assert.throws(
    () => createAgentTask(user, agentId, draft({ scheduleKind: "once", scheduleValue: "2020-01-01T00:00:00Z" })),
    (error: unknown) => error instanceof AgentTaskError && error.status === 400,
  );
});

test("tasks are listed per agent and not across users", () => {
  // A shared agent is visible to everyone who can use it, but a task carries a
  // prompt someone wrote and drives a session private to them.
  const owner = fixture({ shared: true });
  const other = { id: createUser(), role: "user" as const };
  createAgentTask(owner.user, owner.agentId, draft({ name: "mine" }));

  assert.deepEqual(readAgentTasks(owner.user, owner.agentId).map((task) => task.name), ["mine"]);
  assert.deepEqual(readAgentTasks({ ...other, id: other.id }, owner.agentId), []);
});

test("an admin sees tasks they do not own", () => {
  const owner = fixture();
  createAgentTask(owner.user, owner.agentId, draft({ name: "theirs" }));
  const admin = { id: createUser(), role: "admin" as const };
  assert.deepEqual(readAgentTasks(admin, owner.agentId).map((task) => task.name), ["theirs"]);
});

test("a task on another agent reads as not found, not as a wrong-agent error", () => {
  const first = fixture();
  const second = fixture();
  const task = createAgentTask(first.user, first.agentId, draft({}));
  assert.throws(
    () => updateAgentTask(first.user, second.agentId, task.id, { name: "moved" }),
    (error: unknown) => error instanceof AgentTaskError && error.status === 404,
  );
});

test("changing the schedule re-arms the task", () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, draft({ scheduleKind: "interval", scheduleValue: String(3_600_000) }));
  const updated = updateAgentTask(user, agentId, task.id, { scheduleValue: String(60_000) });
  assert.ok(updated.nextRunAt! < task.nextRunAt!);
});

test("resuming a paused task re-arms it instead of firing immediately", () => {
  // A task paused for a week has a `nextRunAt` a week in the past. Resuming is
  // not a request to run right now.
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, draft({ scheduleKind: "interval", scheduleValue: String(60_000) }));
  updateAgentTask(user, agentId, task.id, { status: "paused" });
  const resumed = updateAgentTask(user, agentId, task.id, { status: "active" });
  assert.ok(resumed.nextRunAt! > Date.now());
});

test("only active tasks that are due are returned to the scheduler", () => {
  const { user, agentId } = fixture();
  const due = createAgentTask(user, agentId, draft({ name: "due", scheduleKind: "interval", scheduleValue: String(60_000) }));
  const paused = createAgentTask(user, agentId, draft({ name: "paused", scheduleKind: "interval", scheduleValue: String(60_000) }));
  updateAgentTask(user, agentId, paused.id, { status: "paused" });

  const ids = readDueTasks(Date.now() + 120_000).map((task) => task.id);
  assert.ok(ids.includes(due.id));
  assert.ok(!ids.includes(paused.id));
});

test("deleting an agent takes its tasks with it", () => {
  const { user, agentId } = fixture();
  createAgentTask(user, agentId, draft({}));
  deleteAgentTasksForAgent(agentId);
  assert.deepEqual(readAgentTasks(user, agentId), []);
});

test("deleting a task removes it", async () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, draft({}));
  await deleteAgentTask(user, agentId, task.id);
  assert.deepEqual(readAgentTasks(user, agentId), []);
});

function fixture(options?: { shared?: boolean }) {
  const userId = createUser();
  const modelRefId = createModelRef({ ownerUserId: userId });
  const agentId = createAgent({ ownerUserId: userId, shared: options?.shared, defaultModelRefId: modelRefId });
  return { user: { id: userId, role: "user" as const }, agentId, modelRefId };
}

function draft(overrides: Partial<Parameters<typeof createAgentTask>[2]>) {
  return {
    name: "Nightly",
    prompt: "Summarise today.",
    scheduleKind: "cron" as const,
    scheduleValue: "0 3 * * *",
    timezone: "UTC",
    ...overrides,
  };
}
