import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { agents, agentTasks, agentTaskRuns, modelRefs, sessions, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createAgent, createModelRef, createProviderConfig, createUser } from "../test-support.ts";
import { createAgentTask, deleteAgentTask, readAgentTasks } from "../services/agent-tasks.ts";
import { reassignModelReferences } from "../services/agent-access.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { runTaskNow, tick } from "./task-scheduler.ts";

initialize();

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
});

test("a run the provider fails is recorded as failed, with the reason, not as a success", async () => {
  // The fixture's provider refuses the connection. The run still reaches its
  // end normally -- the failure goes into the transcript -- which is exactly
  // what used to be logged as "succeeded".
  const { user, agentId } = runnableFixture();
  const task = createAgentTask(user, agentId, {
    name: "Doomed",
    prompt: "Try.",
    scheduleKind: "interval",
    scheduleValue: String(60_000),
  });

  await tick(Date.now() + 120_000);

  const [run] = runsFor(task.id);
  assert.equal(run?.outcome, "failed");
  assert.ok(run?.detail, "the run log has no reason");
  assert.ok(run?.sessionId, "a run that started still links its session");
  const stored = row(task.id);
  assert.equal(stored.lastOutcome, "failed");
  assert.equal(stored.lastError, run?.detail);
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

test("a task stops running once its agent is no longer shared with its owner", async () => {
  const { agentId } = runnableFixture();
  db.update(agents).set({ shared: true }).where(eq(agents.id, agentId)).run();
  const other = { id: createUser(), role: "user" as const };
  const task = createAgentTask(other, agentId, {
    name: "Borrowed",
    prompt: "Work on the shared agent.",
    scheduleKind: "interval",
    scheduleValue: String(60_000),
  });

  db.update(agents).set({ shared: false }).where(eq(agents.id, agentId)).run();
  await tick(Date.now() + 120_000);

  const stored = row(task.id);
  assert.equal(stored.lastOutcome, "failed");
  assert.match(stored.lastError ?? "", /no longer available/);
  assert.deepEqual(sessionsFor(task.id), [], "the run must not start in the agent's container");
});

test("an admin's task on another user's private agent keeps running, as creating it was allowed", async () => {
  const { agentId } = runnableFixture();
  const adminId = createUser();
  db.update(users).set({ role: "admin" }).where(eq(users.id, adminId)).run();
  const task = createAgentTask({ id: adminId, role: "admin" }, agentId, {
    name: "Operator check",
    prompt: "Report.",
    scheduleKind: "interval",
    scheduleValue: String(60_000),
  });

  await tick(Date.now() + 120_000);

  assert.doesNotMatch(row(task.id).lastError ?? "", /no longer available/);
  assert.equal(sessionsFor(task.id).length, 1, "the run should have started in a session of its own");
});

test("deleting a task's model hands the task back to its agent's default", () => {
  const { user, agentId, modelRefId } = fixture();
  const task = createAgentTask(user, agentId, {
    name: "Pinned model",
    prompt: "Summarise today.",
    modelRefId,
    scheduleKind: "interval",
    scheduleValue: String(60_000),
  });

  reassignModelReferences(new Set([modelRefId]));

  assert.equal(row(task.id).modelRefId, null);
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
 * at the provider without leaving the machine. `run-result.test.ts` covers the
 * other ways a run ends against a provider that answers.
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
