import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, migrate } from "../db/index.ts";
import { agentTasks, agentTaskRuns, modelRefs, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createAgent, createModelRef, createProviderConfig, createUser } from "../test-support.ts";
import { createAgentTask, deleteAgentTask, readAgentTasks } from "../services/agent-tasks.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { runTaskNow, tick } from "./task-scheduler.ts";

migrate();

test("a task that cannot run fails, re-arms, and leaves no session behind", async () => {
  const { user, agentId } = fixture();
  const task = createAgentTask(user, agentId, {
    name: "Nightly digest",
    prompt: "Summarise today.",
    scheduleKind: "interval",
    scheduleValue: String(60_000),
  });

  await tick(Date.now() + 120_000);

  const stored = row(task.id);
  assert.equal(stored.lastOutcome, "failed", "the fixture has no usable provider");
  // Even a failed firing must re-arm: a task that fails once is not finished.
  assert.ok(stored.nextRunAt && stored.nextRunAt > Date.now());
  const runs = runsFor(task.id);
  assert.equal(runs.length, 1);
  // An hourly task with a broken model would otherwise leave 24 empty sessions a day.
  assert.equal(runs[0]?.sessionId, null);
  assert.deepEqual(sessionsFor(task.id), []);
});

test("every run gets its own session, kept out of the session list and linked from the run log", async () => {
  const { user, agentId } = runnableFixture();
  const task = createAgentTask(user, agentId, {
    name: "Digest",
    prompt: "Summarise today.",
    scheduleKind: "interval",
    scheduleValue: String(60_000),
  });

  await tick(Date.now() + 120_000);
  db.update(agentTasks).set({ nextRunAt: Date.now() - 1_000 }).where(eq(agentTasks.id, task.id)).run();
  await tick(Date.now());

  const runs = runsFor(task.id);
  assert.equal(runs.length, 2);
  // The run reports its provider failure into its transcript; reaching the end is success here.
  assert.deepEqual(runs.map((run) => run.outcome), ["succeeded", "succeeded"]);
  const runSessionIds = runs.map((run) => run.sessionId);
  assert.ok(runSessionIds[0] && runSessionIds[1] && runSessionIds[0] !== runSessionIds[1], "runs shared a session");
  assert.deepEqual(new Set(sessionsFor(task.id).map((session) => session.id)), new Set(runSessionIds));
  assert.ok(sessionsFor(task.id).every((session) => session.title === "Digest"));

  const listed = readBootstrapPayload(user.id).sessions.map((session) => session.id);
  assert.ok(runSessionIds.every((sessionId) => !listed.includes(sessionId!)));
});

test("run now answers with the run's session while it is still going, and does not double up", async () => {
  const { user, agentId } = runnableFixture();
  const task = createAgentTask(user, agentId, {
    name: "Slow",
    prompt: "Take your time.",
    scheduleKind: "interval",
    scheduleValue: String(3_600_000),
  });

  const first = await runTaskNow(row(task.id));
  const second = await runTaskNow(row(task.id));

  assert.equal(first.outcome, "running");
  assert.ok("sessionId" in first && first.sessionId);
  assert.equal(second.outcome, "skipped");
  const [started] = runsFor(task.id);
  assert.equal(started?.outcome, "running");
  assert.equal(started?.sessionId, first.sessionId);

  await waitFor(() => runsFor(task.id)[0]?.outcome !== "running");
  assert.equal(runsFor(task.id).length, 1);
  assert.equal(runsFor(task.id)[0]?.outcome, "succeeded");
});

test("deleting a task deletes its run sessions but not ones moved to the session list", async () => {
  const { user, agentId } = runnableFixture();
  const task = createAgentTask(user, agentId, {
    name: "Twice",
    prompt: "Again.",
    scheduleKind: "interval",
    scheduleValue: String(3_600_000),
  });
  for (let index = 0; index < 2; index++) {
    await runTaskNow(row(task.id));
    await waitFor(() => runsFor(task.id).every((run) => run.outcome !== "running"));
  }
  const [kept, dropped] = runsFor(task.id).map((run) => run.sessionId!);
  db.update(sessions).set({ taskId: null }).where(eq(sessions.id, kept!)).run();

  await deleteAgentTask(user, agentId, task.id);

  const remaining = (sessionId: string) => db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  assert.ok(remaining(kept!));
  assert.equal(remaining(dropped!), undefined);
  assert.deepEqual(runsFor(task.id), []);
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
  assert.equal(runs[0]?.sessionId, null);
  assert.deepEqual(sessionsFor(task.id), []);
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

/**
 * An agent whose model resolves, so runs really start. Ollama needs no
 * credentials, and nothing listens on the discard port, so each run fails fast
 * at the provider without leaving the machine.
 */
function runnableFixture() {
  const userId = createUser();
  const modelRefId = id("model_ref");
  const timestamp = now();
  db.insert(modelRefs)
    .values({
      id: modelRefId,
      ownerUserId: userId,
      label: "Unreachable",
      provider: "ollama",
      modelId: modelRefId,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      input: ["text"],
      reasoning: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  const agentId = createAgent({ ownerUserId: userId, defaultModelRefId: modelRefId });
  return { user: { id: userId, role: "user" as const }, agentId, modelRefId };
}

async function waitFor(condition: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the run to finish.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function sessionsFor(taskId: string) {
  return db.select().from(sessions).where(eq(sessions.taskId, taskId)).all();
}

function row(taskId: string) {
  return db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).get()!;
}

function runsFor(taskId: string) {
  return db.select().from(agentTaskRuns).where(eq(agentTaskRuns.taskId, taskId)).all();
}
