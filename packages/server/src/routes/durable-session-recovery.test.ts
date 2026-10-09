import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import {
  createActiveAgentRun,
  finishAgentRun,
  getActiveAgentRunForSession,
} from "../runtime/run-stream.ts";
import { fauxHarnessModels, openTestHarness } from "../effectors/testing/pi-harness.ts";
import { createSession, createUser } from "../test-support.ts";
import { createAgentRunRoutes } from "./agent-runs.ts";
import { createSessionRoutes } from "./sessions.ts";
import { readSessionConnection } from "../services/session-snapshot.ts";

initialize();

test("restart reports pending work without executing it and Stop settles it without provider credentials", async () => {
  const fixture = createSession();
  const { models, model, faux } = fauxHarnessModels();
  let executions = 0;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Resumed"),
  ]);
  const first = await openTestHarness(fixture.sessionId, {
    models,
    model,
    tools: [
      {
        name: "lookup",
        label: "Lookup",
        description: "Read-only lookup",
        replay: "safe",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_id, _args, _update, _tools, _invocation, context) {
          executions++;
          started();
          await new Promise((_, reject) =>
            context.abortSignal!.addEventListener(
              "abort",
              () => reject(context.abortSignal!.reason),
              { once: true },
            ),
          );
          return { content: [{ type: "text", text: "done" }] };
        },
      },
    ],
  });
  await first.session.conversation.submit(
    { type: "input", content: "Lookup", whenBusy: "reject" },
    first.context,
  );
  await entered;
  await first.close();

  const app = appFor(fixture.userId);
  const snapshot = await readSessionConnection(fixture.userId, fixture.sessionId);
  assert.equal(snapshot?.activeRun, null);
  assert.equal(snapshot?.pendingWork, true);
  assert.equal(executions, 1, "read-only reconnect must not replay a safe tool");
  const entryId = snapshot!.session.messageEntryIds[0]!;
  const truncate = () =>
    app.request(`/sessions/${fixture.sessionId}/messages/truncate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
  assert.equal((await truncate()).status, 409);

  const denied = await appFor(createUser()).request(`/sessions/${fixture.sessionId}/abort`, {
    method: "POST",
  });
  assert.equal(denied.status, 404);
  assert.equal((await readSessionConnection(fixture.userId, fixture.sessionId))?.pendingWork, true);

  const stopped = await app.request(`/sessions/${fixture.sessionId}/abort`, { method: "POST" });
  assert.equal(stopped.status, 200);
  const settled = await readSessionConnection(fixture.userId, fixture.sessionId);
  assert.equal(settled?.pendingWork, false);
  assert.equal(executions, 1, "Stop must not rerun the interrupted tool");
  assert.equal(settled?.session.messages.filter((m) => m.role === "user").length, 1);
  const result = settled?.session.messages.find((m) => m.role === "toolResult");
  assert.ok(result?.role === "toolResult" && result.isError);
  assert.equal((await truncate()).status, 200, "retry can rewind after Stop");
  assert.equal(
    (await app.request(`/sessions/${fixture.sessionId}/abort`, { method: "POST" })).status,
    200,
  );
});

test("session Stop delegates to the current run and preserves its lease until finalization", async () => {
  const fixture = createSession();
  let aborted = false;
  const run = createActiveAgentRun({
    runId: crypto.randomUUID(),
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {
      aborted = true;
    },
  });
  try {
    const response = await appFor(fixture.userId).request(`/sessions/${fixture.sessionId}/abort`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal(aborted, true);
    assert.equal(getActiveAgentRunForSession(fixture.userId, fixture.sessionId)?.runId, run.runId);
  } finally {
    finishAgentRun(run);
  }
});

test("session Stop leaves issue attempts under the issue's cancellation authority", async () => {
  const fixture = createSession();
  db.update(sessions)
    .set({ issueId: "test-issue" })
    .where(eq(sessions.id, fixture.sessionId))
    .run();
  assert.equal(
    (
      await appFor(fixture.userId).request(`/sessions/${fixture.sessionId}/abort`, {
        method: "POST",
      })
    ).status,
    409,
  );
});

function appFor(userId: string) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createAgentRunRoutes());
  app.route("/", createSessionRoutes());
  return app;
}
