import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { ActivityPage } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { activity, agents, agentTasks, issues, sessions, users } from "../db/schema.ts";
import { createSession, createUser } from "../test-support.ts";
import { id } from "../db/seed.ts";
import { readActivity, recordSessionActivity, recordTaskActivity } from "../services/activity.ts";
import { finishTaskRun, markInterruptedTaskRuns, recordTaskRun, startTaskRun } from "../services/agent-tasks.ts";
import { updateIssue } from "../services/issues.ts";
import { createActivityRoutes } from "./activity.ts";

migrate();

function appAs(userId: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", db.select().from(users).where(eq(users.id, userId)).get()!);
    await next();
  });
  return app.route("/", createActivityRoutes());
}
const json = { "content-type": "application/json" };

async function read(userId: string, query = "") {
  const response = await appAs(userId).request(`/activity${query}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<ActivityPage>;
}

async function mark(userId: string, ids: number[], read = true) {
  return appAs(userId).request("/activity/read", { method: "PATCH", headers: json, body: JSON.stringify({ ids, read }) });
}

test("activity is private, rechecks shared-agent access, and cannot be marked by another user", async () => {
  const owner = createSession();
  const viewer = createSession();
  db.update(agents).set({ shared: true }).where(eq(agents.id, owner.agentId)).run();
  db.update(sessions).set({ agentId: owner.agentId }).where(eq(sessions.id, viewer.sessionId)).run();
  recordSessionActivity(owner.sessionId, "owner", { outcome: "succeeded" });
  recordSessionActivity(viewer.sessionId, "viewer", { outcome: "failed", detail: "Provider unavailable" });
  const ownerInbox = await read(owner.userId);
  const viewerInbox = await read(viewer.userId);
  assert.equal(ownerInbox.items.length, 1);
  assert.equal(viewerInbox.items.length, 1);
  assert.notEqual(ownerInbox.items[0]!.id, viewerInbox.items[0]!.id);
  await mark(owner.userId, [viewerInbox.items[0]!.id]);
  assert.equal((await read(viewer.userId)).unreadCount, 1);
  db.update(agents).set({ shared: false }).where(eq(agents.id, owner.agentId)).run();
  assert.deepEqual(await read(viewer.userId), { items: [], unreadCount: 0, nextCursor: null });
  await mark(viewer.userId, [viewerInbox.items[0]!.id]);
  assert.equal(db.select().from(activity).where(eq(activity.id, viewerInbox.items[0]!.id)).get()!.readAt, null);
});

test("read state persists, late arrivals stay unread, and recording is idempotent", async () => {
  const fixture = createSession();
  recordSessionActivity(fixture.sessionId, "first", { outcome: "succeeded" });
  const first = await read(fixture.userId);
  recordSessionActivity(fixture.sessionId, "later", { outcome: "failed", detail: "Try again" });
  await mark(fixture.userId, first.items.map((item) => item.id));
  recordSessionActivity(fixture.sessionId, "first", { outcome: "succeeded" });
  assert.equal((await read(fixture.userId)).unreadCount, 1);
  const all = await read(fixture.userId, "?filter=all");
  assert.equal(all.items.length, 2);
  assert.equal(all.items[1]!.id, first.items[0]!.id);
  assert.ok(all.items[1]!.readAt);
  await mark(fixture.userId, [first.items[0]!.id], false);
  assert.equal((await read(fixture.userId)).unreadCount, 2);
  assert.equal((await read(fixture.userId, "?filter=attention")).items.length, 1);
});

test("issue verdicts appear once, failures outrank done, and resolving acknowledges activity", async () => {
  const f = createSession();
  const issueId = id("issue");
  db.update(sessions).set({ issueId }).where(eq(sessions.id, f.sessionId)).run();
  db.insert(issues).values({ id: issueId, agentId: f.agentId, userId: f.userId, sessionId: f.sessionId,
    title: "Make a decision", description: "Choose", verdict: "needs_input", verdictSummary: "Which region?", createdAt: 1, updatedAt: 1 }).run();
  recordSessionActivity(f.sessionId, "question", { outcome: "succeeded" });
  let inbox = await read(f.userId);
  assert.equal(inbox.items[0]!.kind, "needs_input");
  assert.equal(inbox.items[0]!.summary, "Which region?");
  assert.equal(inbox.items[0]!.issueId, issueId);
  db.update(issues).set({ verdict: "done" }).where(eq(issues.id, issueId)).run();
  recordSessionActivity(f.sessionId, "failed-after-report", { outcome: "failed", detail: "Could not save" });
  inbox = await read(f.userId);
  assert.equal(inbox.items[0]!.kind, "failed");
  assert.equal(inbox.items[0]!.summary, "Could not save");
  updateIssue(f.userId, f.agentId, issueId, { status: "resolved" });
  assert.equal((await read(f.userId)).unreadCount, 0);
  assert.equal((await read(f.userId, "?filter=all")).items.length, 2);
  recordSessionActivity(f.sessionId, "cancelled", { outcome: "cancelled" });
  assert.equal((await read(f.userId)).unreadCount, 0);
});

test("scheduled failures without sessions, completion and interrupted recovery reach the inbox", async () => {
  const f = createSession();
  const taskId = id("task");
  db.insert(agentTasks).values({ id: taskId, agentId: f.agentId, userId: f.userId, name: "Daily audit", prompt: "Audit", scheduleKind: "interval", scheduleValue: "3600", createdAt: 1, updatedAt: 1 }).run();
  recordTaskRun({ taskId, scheduledFor: 1, startedAt: 1, outcome: "failed", detail: "No model" });
  let inbox = await read(f.userId);
  assert.equal(inbox.items[0]!.sessionId, null);
  assert.equal(inbox.items[0]!.taskId, taskId);
  assert.equal(inbox.items[0]!.summary, "No model");
  db.update(sessions).set({ taskId }).where(eq(sessions.id, f.sessionId)).run();
  recordSessionActivity(f.sessionId, "task-session", { outcome: "succeeded" });
  assert.equal((await read(f.userId)).items.length, 1, "task completions are owned by the task run log");
  const runId = startTaskRun({ taskId, scheduledFor: 2, startedAt: 2, sessionId: f.sessionId });
  finishTaskRun(runId, { outcome: "succeeded" });
  recordTaskActivity(runId);
  inbox = await read(f.userId);
  assert.equal(inbox.items.length, 2);
  assert.equal(inbox.items[0]!.kind, "completed");
  startTaskRun({ taskId, scheduledFor: 3, startedAt: 3, sessionId: f.sessionId });
  markInterruptedTaskRuns();
  assert.equal((await read(f.userId)).items[0]!.kind, "interrupted");
});

test("cursor pagination is stable across new arrivals and source deletion removes dead links", async () => {
  const f = createSession();
  for (let i = 0; i < 53; i++) recordSessionActivity(f.sessionId, `page-${i}`, { outcome: "succeeded" });
  const page = await read(f.userId, "?filter=all");
  assert.equal(page.items.length, 50);
  assert.ok(page.nextCursor);
  recordSessionActivity(f.sessionId, "new-page-arrival", { outcome: "succeeded" });
  const older = await read(f.userId, `?filter=all&before=${page.nextCursor}`);
  assert.equal(older.items.length, 3);
  assert.equal(older.nextCursor, null);
  assert.ok(older.items.every((item) => item.id < page.nextCursor!));
  db.delete(sessions).where(eq(sessions.id, f.sessionId)).run();
  assert.equal(readActivity(f.userId).unreadCount, 0);
});

test("activity routes validate cursors, filters, and read mutations", async () => {
  const user = createUser();
  const app = appAs(user);
  for (const query of ["?before=-1", "?before=no", "?filter=unknown"]) assert.equal((await app.request(`/activity${query}`)).status, 400);
  assert.equal((await mark(user, [])).status, 400);
  assert.equal((await mark(user, [-1])).status, 400);
  assert.equal((await mark(user, Array(501).fill(1))).status, 400);
});
