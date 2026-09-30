import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { IssueDetail } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { issues, issueAttempts, modelRefs, sessions, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import {
  createIssue,
  readIssueView,
  runIssue,
  finishIssueAttempt,
  issueRunAddons,
  recoverIssueAttempts,
  interruptIssue,
} from "../services/issues.ts";
import { createAgent, createUser } from "../test-support.ts";
import { createIssueRoutes } from "./issues.ts";
import { createSessionRoutes } from "./sessions.ts";
import { createAgentRunRoutes } from "./agent-runs.ts";

migrate();
const json = { "content-type": "application/json" };

test("creating a brief and adding notes never starts work or requires a model", async () => {
  const f = fixture();
  const app = appAs(f.userId);
  const response = await app.request(`/agents/${f.agentId}/issues`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      title: "Tidy README",
      description: "Explain setup.",
      criteria: ["Setup is reproducible"],
      status: "backlog",
    }),
  });
  assert.equal(response.status, 201);
  const issue = (await response.json()) as IssueDetail;
  assert.equal(issue.status, "backlog");
  assert.equal(issue.running, false);
  assert.equal(issue.sessionId, undefined);
  assert.deepEqual(issue.attempts, []);
  assert.deepEqual(issue.criteria, ["Setup is reproducible"]);
  const noted = await post(app, f.agentId, issue.id, "notes", {
    body: "Keep the examples short.",
  });
  assert.equal(noted.status, 200);
  const detail = (await noted.json()) as IssueDetail;
  assert.equal(detail.notes.at(-1)?.body, "Keep the examples short.");
  assert.equal(detail.attempts.length, 0);
  assert.equal(detail.status, "backlog");
  assert.equal((await post(app, f.agentId, issue.id, "notes", { body: "  " })).status, 400);
});

test("replies reuse the conversation; failures persist in attempt history", async () => {
  const f = fixture();
  const app = appAs(f.userId);
  const issue = createIssue(f.userId, f.agentId, {
    title: "Fix",
    description: "Fix it",
  });
  const start = await post(app, f.agentId, issue.id, "runs", {});
  assert.equal(start.status, 200);
  const running = (await start.json()) as IssueDetail;
  assert.equal(running.attempts.length, 1);
  assert.ok(running.sessionId);
  assert.equal(db.select().from(sessions).where(eq(sessions.id, running.sessionId)).get()?.agentId, f.agentId);
  assert.ok(!readBootstrapPayload(f.userId).sessions.some((s) => s.id === running.sessionId));
  await waitFor(() => !readIssueView(f.userId, f.agentId, issue.id).running);
  const failed = readIssueView(f.userId, f.agentId, issue.id);
  assert.equal(failed.status, "backlog");
  assert.equal(failed.attempts[0]?.outcome, "failed");
  assert.equal(
    (
      await post(app, f.agentId, issue.id, "runs", {
        instructions: "Try again",
      })
    ).status,
    200,
  );
  await waitFor(() => !readIssueView(f.userId, f.agentId, issue.id).running);
  const retried = readIssueView(f.userId, f.agentId, issue.id);
  assert.equal(retried.attempts.length, 2);
  assert.equal(retried.attempts[0]?.sessionId, retried.attempts[1]?.sessionId);
  assert.match(retried.attempts[0]!.brief, /Previous attempts/);
});

test("a start claim rejects concurrent starts and can be interrupted during credential resolution", async () => {
  const f = fixture();
  const issue = createIssue(f.userId, f.agentId, {
    title: "Fix",
    description: "Fix it",
  });
  const starting = runIssue(f.userId, f.agentId, issue.id, {});
  await assert.rejects(runIssue(f.userId, f.agentId, issue.id, {}), /still working/);
  await starting;
  await waitFor(() => !readIssueView(f.userId, f.agentId, issue.id).running);
  assert.equal(readIssueView(f.userId, f.agentId, issue.id).attempts.length, 1);
  const pending = runIssue(f.userId, f.agentId, issue.id, {});
  interruptIssue(f.userId, f.agentId, issue.id);
  await assert.rejects(pending, /stopped before/);
  const detail = readIssueView(f.userId, f.agentId, issue.id);
  assert.equal(detail.attempts[0]?.outcome, "interrupted");
  assert.equal(detail.attempts[0]?.sessionId, null);
});

test("preflight errors leave a durable failed attempt without a session", async () => {
  const f = fixture();
  const issue = createIssue(f.userId, f.agentId, {
    title: "Fix",
    description: "Fix it",
  });
  await assert.rejects(runIssue(f.userId, f.agentId, issue.id, { modelRefId: "missing" }), /Model not found/);
  const detail = readIssueView(f.userId, f.agentId, issue.id);
  assert.equal(detail.status, "backlog");
  assert.equal(detail.attempts[0]?.sessionId, null);
  assert.equal(detail.attempts[0]?.outcome, "failed");
});

test("agent delivery waits for human review; notes never reopen accepted work", async () => {
  const f = activeFixture();
  const app = appAs(f.userId);
  await report(f, {
    state: "done",
    summary: "Updated the guide.",
    evidence: "Checked all three setup commands.",
  });
  assert.equal((await post(app, f.agentId, f.issueId, "accept")).status, 409);
  finishIssueAttempt(f.attemptId, { outcome: "succeeded" });
  assert.equal(readIssueView(f.userId, f.agentId, f.issueId).status, "in_review");
  assert.equal((await post(app, f.agentId, f.issueId, "runs", {})).status, 400);
  const accepted = await post(app, f.agentId, f.issueId, "accept");
  assert.equal(accepted.status, 200);
  assert.equal(((await accepted.json()) as IssueDetail).status, "done");
  await post(app, f.agentId, f.issueId, "notes", { body: "Thanks, shipped." });
  const done = readIssueView(f.userId, f.agentId, f.issueId);
  assert.equal(done.status, "done");
  assert.equal(done.attempts.length, 1);
  assert.equal((await post(app, f.agentId, f.issueId, "runs", { instructions: "More" })).status, 409);
  const reopened = await post(app, f.agentId, f.issueId, "reopen");
  assert.equal(((await reopened.json()) as IssueDetail).status, "backlog");
  assert.equal(readIssueView(f.userId, f.agentId, f.issueId).running, false);
  await assert.rejects(report(f, { state: "done", summary: "Stale", evidence: "" }), /no longer active/);
});

test("needs-input, failed reports, and restart recovery preserve attempt evidence", async () => {
  const f = activeFixture();
  await report(f, {
    state: "needs_input",
    summary: "Which branch?",
    evidence: "Inspected branches.",
  });
  finishIssueAttempt(f.attemptId, { outcome: "succeeded" });
  assert.equal(readIssueView(f.userId, f.agentId, f.issueId).status, "needs_input");
  const failure = activeFixture();
  await report(failure, {
    state: "done",
    summary: "Done",
    evidence: "Tests passed",
  });
  finishIssueAttempt(failure.attemptId, {
    outcome: "failed",
    detail: "Persistence failed",
  });
  const detail = readIssueView(failure.userId, failure.agentId, failure.issueId);
  assert.equal(detail.status, "backlog");
  assert.equal(detail.attempts[0]?.summary, "Persistence failed");
  assert.equal(detail.attempts[0]?.evidence, "Tests passed");
  assert.equal(detail.notes.at(-1)?.kind, "result");
  assert.match(detail.notes.at(-1)!.body, /Persistence failed/);
  const interrupted = activeFixture();
  recoverIssueAttempts();
  recoverIssueAttempts();
  assert.equal(
    readIssueView(interrupted.userId, interrupted.agentId, interrupted.issueId).attempts[0]?.outcome,
    "interrupted",
  );
});

test("active work rejects edits and deletion; cancellation cannot be overwritten by late completion", async () => {
  const f = activeFixture();
  const app = appAs(f.userId);
  let aborts = 0;
  const run = createActiveAgentRun({
    runId: id("run"),
    userId: f.userId,
    sessionId: f.sessionId,
    abort: () => {
      aborts++;
    },
  });
  assert.equal(
    (
      await app.request(`/agents/${f.agentId}/issues/${f.issueId}`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ title: "new" }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await app.request(`/agents/${f.agentId}/issues/${f.issueId}`, {
        method: "DELETE",
      })
    ).status,
    409,
  );
  await post(app, f.agentId, f.issueId, "cancel");
  assert.equal(aborts, 1);
  finishAgentRun(run, { outcome: "succeeded" });
  finishIssueAttempt(f.attemptId, { outcome: "succeeded" });
  assert.equal(readIssueView(f.userId, f.agentId, f.issueId).status, "cancelled");
  assert.equal(
    (
      await app.request(`/agents/${f.agentId}/issues/${f.issueId}`, {
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(db.select().from(sessions).where(eq(sessions.id, f.sessionId)).get(), undefined);
  assert.equal(db.select().from(issueAttempts).where(eq(issueAttempts.id, f.attemptId)).get(), undefined);
});

test("issue attempt sessions cannot be reused, edited, forked, or deleted through chat APIs", async () => {
  const f = activeFixture();
  finishIssueAttempt(f.attemptId, { outcome: "succeeded" });
  const app = appAs(f.userId);
  for (const [method, path, body] of [
    ["POST", `/agents/${f.agentId}/run`, { sessionId: f.sessionId, promptInput: { text: "Bypass" } }],
    ["PATCH", `/sessions/${f.sessionId}`, { title: "Bypass" }],
    ["DELETE", `/sessions/${f.sessionId}`, undefined],
    ["POST", `/sessions/${f.sessionId}/fork`, { entryId: "entry" }],
    ["POST", `/sessions/${f.sessionId}/messages/truncate`, { entryId: "entry" }],
  ] as const)
    assert.equal(
      (
        await app.request(path, {
          method,
          headers: json,
          body: body ? JSON.stringify(body) : undefined,
        })
      ).status,
      409,
      path,
    );
});

test("every issue action enforces both user and agent ownership", async () => {
  const f = activeFixture({ shared: true });
  const stranger = appAs(createUser());
  const owner = appAs(f.userId);
  assert.deepEqual(await (await stranger.request(`/agents/${f.agentId}/issues`)).json(), []);
  for (const action of ["runs", "notes", "accept", "reopen", "cancel", "interrupt"]) {
    const body = action === "notes" ? { body: "Hello" } : {};
    assert.equal((await post(stranger, f.agentId, f.issueId, action, body)).status, 404);
    const otherAgent = createAgent({
      ownerUserId: f.userId,
      defaultModelRefId: f.modelRefId,
    });
    assert.equal((await post(owner, otherAgent, f.issueId, action, body)).status, 404);
  }
  finishIssueAttempt(f.attemptId, { outcome: "interrupted" });
});

function appAs(userId: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", db.select().from(users).where(eq(users.id, userId)).get()!);
    await next();
  });
  app.route("/", createIssueRoutes());
  app.route("/", createSessionRoutes());
  app.route("/", createAgentRunRoutes());
  return app;
}
function post(app: ReturnType<typeof appAs>, agentId: string, issueId: string, action: string, body: object = {}) {
  return app.request(`/agents/${agentId}/issues/${issueId}/${action}`, {
    method: "POST",
    headers: json,
    body: JSON.stringify(body),
  });
}
function fixture(options?: { shared?: boolean }) {
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
  return {
    userId,
    modelRefId,
    agentId: createAgent({
      ownerUserId: userId,
      shared: options?.shared,
      defaultModelRefId: modelRefId,
    }),
  };
}
function activeFixture(options?: { shared?: boolean }) {
  const f = fixture(options);
  const issue = createIssue(f.userId, f.agentId, {
    title: "Issue",
    description: "Do it",
    criteria: ["Works"],
  });
  const sessionId = id("session");
  const attemptId = id("attempt");
  db.insert(sessions)
    .values({
      id: sessionId,
      ...f,
      title: "Issue",
      issueId: issue.id,
      thinkingLevel: "off",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  db.insert(issueAttempts)
    .values({
      id: attemptId,
      issueId: issue.id,
      sessionId,
      instructions: "",
      brief: "Do it",
      outcome: "running",
      createdAt: now(),
    })
    .run();
  db.update(issues).set({ sessionId, status: "in_progress" }).where(eq(issues.id, issue.id)).run();
  return { ...f, issueId: issue.id, sessionId, attemptId };
}
function report(f: ReturnType<typeof activeFixture>, params: unknown) {
  const tool = issueRunAddons(f.issueId, f.attemptId).tools[0]!;
  return (tool.execute as (...args: unknown[]) => Promise<unknown>)("call", params);
}
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Run timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
