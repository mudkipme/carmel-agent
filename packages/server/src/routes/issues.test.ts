import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Issue } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { issues, modelRefs, sessions, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { issueRunAddons, noteIssueRunStarted } from "../services/issues.ts";
import { createAgent, createUser } from "../test-support.ts";
import { createIssueRoutes } from "./issues.ts";

migrate();
const json = { "content-type": "application/json" };

test("an issue starts a run in a session of its own, kept out of the session list", async () => {
  const { userId, agentId } = runnableFixture();
  const app = appAs(userId);

  const created = await app.request(`/agents/${agentId}/issues`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ title: "Tidy the README", description: "It is out of date." }),
  });
  assert.equal(created.status, 201);
  const issue = (await created.json()) as Issue;
  assert.equal(issue.status, "open");
  assert.equal(issue.running, true);

  const session = db.select().from(sessions).where(eq(sessions.id, issue.sessionId)).get();
  assert.equal(session?.issueId, issue.id);
  assert.equal(session?.title, "Tidy the README");
  assert.ok(!readBootstrapPayload(userId).sessions.some((listed) => listed.id === issue.sessionId));

  // Nothing listens on the fixture's provider, so the run fails fast, and the
  // issue has to record that on its own: nobody is watching the stream.
  await waitFor(() => row(issue.id).lastRunOutcome !== null);
  const finished = await read(app, agentId, issue.id);
  assert.equal(finished.running, false);
  assert.equal(finished.lastRunOutcome, "failed");
  assert.equal(finished.status, "open", "a failed run leaves the issue for the user to decide");

  const listed = (await (await app.request(`/agents/${agentId}/issues`)).json()) as Issue[];
  assert.deepEqual(listed.map((entry) => entry.id), [issue.id]);
});

test("a running issue can be interrupted or cancelled, but not resolved or deleted", async () => {
  const { userId, agentId, issueId, sessionId } = issueFixture();
  const app = appAs(userId);
  let aborts = 0;
  const run = createActiveAgentRun({ runId: id("run"), userId, sessionId, abort: () => { aborts += 1; } });

  assert.equal((await read(app, agentId, issueId)).running, true);
  assert.equal((await patch(app, agentId, issueId, { status: "resolved" })).status, 409);
  assert.equal((await app.request(`/agents/${agentId}/issues/${issueId}`, { method: "DELETE" })).status, 409);

  const interrupted = (await (await app.request(`/agents/${agentId}/issues/${issueId}/interrupt`, { method: "POST" })).json()) as Issue;
  assert.equal(aborts, 1);
  assert.equal(interrupted.status, "open", "interrupting pauses the work without settling the issue");

  const cancelled = (await (await app.request(`/agents/${agentId}/issues/${issueId}/cancel`, { method: "POST" })).json()) as Issue;
  assert.equal(aborts, 2);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.closedAt);

  finishAgentRun(run, { outcome: "cancelled" });
  assert.equal((await app.request(`/agents/${agentId}/issues/${issueId}`, { method: "DELETE" })).status, 200);
  assert.equal(db.select().from(sessions).where(eq(sessions.id, sessionId)).get(), undefined);
  assert.equal(db.select().from(issues).where(eq(issues.id, issueId)).get(), undefined);
});

test("resolving closes an issue, and a reply reopens it", async () => {
  const { userId, agentId, issueId, sessionId } = issueFixture();
  const app = appAs(userId);

  const resolved = (await (await patch(app, agentId, issueId, { status: "resolved" })).json()) as Issue;
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.closedAt);

  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
  const run = createActiveAgentRun({ runId: id("run"), userId, sessionId, abort: () => {} });
  noteIssueRunStarted(session, run);
  const reopened = await read(app, agentId, issueId);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.closedAt, undefined);
  assert.equal(reopened.running, true);

  finishAgentRun(run, { outcome: "succeeded" });
  // Recorded as the run is released, not on a later poll: a read in between
  // would otherwise see a stopped run still carrying the previous outcome.
  assert.equal(row(issueId).lastRunOutcome, "succeeded");
});

test("the agent reports its verdict through report_issue, and a new run clears it", async () => {
  const { userId, agentId, issueId, sessionId } = issueFixture();
  const app = appAs(userId);
  const tool = issueRunAddons(issueId)!.tools.find((candidate) => candidate.name === "report_issue")!;
  const report = (params: unknown) => (tool.execute as (...args: unknown[]) => Promise<unknown>)("call_1", params);

  await report({ state: "needs_input", summary: "Which branch should the fix go on?" });
  const asking = await read(app, agentId, issueId);
  assert.equal(asking.verdict, "needs_input");
  assert.equal(asking.verdictSummary, "Which branch should the fix go on?");

  await assert.rejects(report({ state: "finished", summary: "x" }), /state must be one of/);
  await assert.rejects(report({ state: "done", summary: "  " }), /summary is required/);
  assert.equal((await read(app, agentId, issueId)).verdict, "needs_input", "a rejected report changes nothing");

  // The reply answers the question, so the question must not outlive it.
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
  const run = createActiveAgentRun({ runId: id("run"), userId, sessionId, abort: () => {} });
  noteIssueRunStarted(session, run);
  const replied = await read(app, agentId, issueId);
  assert.equal(replied.verdict, undefined);
  assert.equal(replied.verdictSummary, undefined);
  finishAgentRun(run, { outcome: "succeeded" });
});

test("only issue sessions get the report tool and its instructions", () => {
  assert.equal(issueRunAddons(null), undefined);
  const addons = issueRunAddons("issue_x");
  assert.deepEqual(addons?.tools.map((tool) => tool.name), ["report_issue"]);
  assert.match(addons?.instructions ?? "", /report_issue/);
});

test("renaming an issue renames its session", async () => {
  const { userId, agentId, issueId, sessionId } = issueFixture();
  const renamed = (await (await patch(appAs(userId), agentId, issueId, { title: "Sharper title" })).json()) as Issue;
  assert.equal(renamed.title, "Sharper title");
  assert.equal(db.select().from(sessions).where(eq(sessions.id, sessionId)).get()?.title, "Sharper title");
});

test("another user cannot see or reach someone else's issue, even on a shared agent", async () => {
  const { userId, agentId, issueId } = issueFixture({ shared: true });
  const stranger = appAs(createUser());
  assert.deepEqual(await (await stranger.request(`/agents/${agentId}/issues`)).json(), []);
  assert.equal((await stranger.request(`/agents/${agentId}/issues/${issueId}`)).status, 404);
  assert.equal((await stranger.request(`/agents/${agentId}/issues/${issueId}/cancel`, { method: "POST" })).status, 404);
  assert.equal(row(issueId).status, "open");
  assert.equal((await appAs(userId).request(`/agents/${agentId}/issues/${issueId}`)).status, 200);
});

function appAs(userId: string) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createIssueRoutes());
  return app;
}

async function read(app: Hono<{ Variables: AuthVariables }>, agentId: string, issueId: string) {
  return (await (await app.request(`/agents/${agentId}/issues/${issueId}`)).json()) as Issue;
}

function patch(app: Hono<{ Variables: AuthVariables }>, agentId: string, issueId: string, body: object) {
  return app.request(`/agents/${agentId}/issues/${issueId}`, { method: "PATCH", headers: json, body: JSON.stringify(body) });
}

function row(issueId: string) {
  return db.select().from(issues).where(eq(issues.id, issueId)).get()!;
}

/** An issue written straight to the database, with no run behind it. */
function issueFixture(options?: { shared?: boolean }) {
  const { userId, agentId, modelRefId } = runnableFixture(options);
  const issueId = id("issue");
  const sessionId = id("session");
  const timestamp = now();
  db.insert(sessions)
    .values({ id: sessionId, title: "Issue", userId, agentId, modelRefId, thinkingLevel: "off", issueId, createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(issues)
    .values({ id: issueId, agentId, userId, sessionId, title: "Issue", description: "Do it.", createdAt: timestamp, updatedAt: timestamp })
    .run();
  return { userId, agentId, issueId, sessionId };
}

/** Same idea as the scheduler tests: a model that resolves, served from a port nothing listens on. */
function runnableFixture(options?: { shared?: boolean }) {
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
  const agentId = createAgent({ ownerUserId: userId, shared: options?.shared, defaultModelRefId: modelRefId });
  return { userId, agentId, modelRefId };
}

async function waitFor(condition: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the run to finish.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
