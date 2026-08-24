import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, migrate } from "../db/index.ts";
import { agentTasks, agentTaskRuns } from "../db/schema.ts";
import { createAgent, createModelRef, createProviderConfig, createUser } from "../test-support.ts";
import { createAgentTask, readAgentTasks } from "../services/agent-tasks.ts";
import { tick } from "./task-scheduler.ts";

migrate();

test("a due task creates its session, appends a turn, and re-arms", async () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, {
    name: "Nightly digest",
    prompt: "Summarise today.",
    scheduleKind: "interval",
    scheduleValue: String(60_000),
  });

  await tick(Date.now() + 120_000);

  const stored = row(task.id);
  // The session is created lazily on the first firing and named after the task.
  assert.ok(stored.sessionId, "no session was created");
  assert.equal(stored.lastOutcome, "failed", "the faux fixture has no usable provider");
  // Even a failed firing must re-arm: a task that fails once is not finished.
  assert.ok(stored.nextRunAt && stored.nextRunAt > Date.now());
  assert.equal(runsFor(task.id).length, 1);
});

test("a task that is not due is left alone", async () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, {
    name: "Later",
    prompt: "Not yet.",
    scheduleKind: "interval",
    scheduleValue: String(3_600_000),
  });

  await tick(Date.now());

  assert.equal(row(task.id).lastRunAt, null);
  assert.deepEqual(runsFor(task.id), []);
});

test("an occurrence missed while the server was down is recorded, not replayed", async () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, {
    name: "Daily",
    prompt: "Summarise.",
    scheduleKind: "cron",
    scheduleValue: "0 3 * * *",
    timezone: "UTC",
  });
  // Backdate as though the process had been off for three days.
  db.update(agentTasks).set({ nextRunAt: Date.now() - 3 * 86_400_000 }).where(eq(agentTasks.id, task.id)).run();

  await tick(Date.now());

  const runs = runsFor(task.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.outcome, "missed");
  // No session, because nothing ran -- and the schedule has moved to the future.
  assert.equal(row(task.id).sessionId, null);
  assert.ok(row(task.id).nextRunAt! > Date.now());
});

test("a paused task is never fired however overdue", async () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, {
    name: "Paused",
    prompt: "Nope.",
    scheduleKind: "interval",
    scheduleValue: String(60_000),
    status: "paused",
  });
  db.update(agentTasks).set({ nextRunAt: Date.now() - 86_400_000 }).where(eq(agentTasks.id, task.id)).run();

  await tick(Date.now());
  assert.deepEqual(runsFor(task.id), []);
});

test("a one-shot completes after firing instead of re-arming", async () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, {
    name: "Once",
    prompt: "Just once.",
    scheduleKind: "once",
    scheduleValue: new Date(Date.now() + 1_000).toISOString(),
  });

  await tick(Date.now() + 5_000);

  const stored = row(task.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.nextRunAt, null);
  assert.equal(runsFor(task.id).length, 1);
});

test("a task whose session already has a run in flight is skipped, not doubled", async () => {
  // The overlap guard. Its own previous firing, or a person prompting in the
  // task's session, both mean wait for the next tick.
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, {
    name: "Slow",
    prompt: "Take your time.",
    scheduleKind: "interval",
    scheduleValue: String(60_000),
  });

  await tick(Date.now() + 120_000);
  const sessionId = row(task.id).sessionId!;
  const { createActiveAgentRun, finishAgentRun } = await import("./run-stream.ts");
  const held = createActiveAgentRun({ runId: "run_held", userId: user.id, sessionId, abort: () => {} });

  db.update(agentTasks).set({ nextRunAt: Date.now() - 1_000 }).where(eq(agentTasks.id, task.id)).run();
  await tick(Date.now());
  finishAgentRun(held);

  const outcomes = runsFor(task.id).map((run) => run.outcome);
  assert.ok(outcomes.includes("skipped"), outcomes.join(","));
});

test("tasks appear on the agent they belong to", async () => {
  const { user, agentId } = fixture();
  createAgentTask(user, agentId, { name: "A", prompt: "x", scheduleKind: "interval", scheduleValue: String(60_000) });
  assert.deepEqual(readAgentTasks(user, agentId).map((task) => task.name), ["A"]);
});

function fixture() {
  const userId = createUser();
  const providerConfigId = createProviderConfig(userId);
  const modelRefId = createModelRef({ ownerUserId: userId, providerConfigId });
  const agentId = createAgent({ ownerUserId: userId, defaultModelRefId: modelRefId });
  return { user: { id: userId, role: "user" as const }, agentId, modelRefId };
}

function row(taskId: string) {
  return db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).get()!;
}

function runsFor(taskId: string) {
  return db.select().from(agentTaskRuns).where(eq(agentTaskRuns.taskId, taskId)).all();
}
