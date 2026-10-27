import test from "node:test";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { createHelperRoutes } from "../routes/helpers.ts";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { db, initialize } from "../db/index.ts";
import { agents, homeEvents, users, issues, issueAttempts, sessions } from "../db/schema.ts";
import { createIssue, issueRunAddons } from "../services/issues.ts";
import { createSession, createUser } from "../test-support.ts";
import {
  fauxHarnessModels,
  openTestHarness,
  TEST_CONTEXT,
} from "../effectors/testing/pi-harness.ts";
import { createHelperExtension, Helpers, helperTasks, readHelpers, stopHelper } from "./helpers.ts";
import { hasPendingPiSessionWork } from "../services/pi-session-storage.ts";
import type { ConversationId, TaskId, ToolRegistration } from "@earendil-works/pi-durable";

initialize();

function setup() {
  const fixture = createSession();
  const models = fauxHarnessModels();
  const extension = createHelperExtension(fixture);
  return {
    fixture,
    models,
    options: { ...models, tools: [...extension.tools!], extensions: [helperTasks, extension] },
  };
}
const call = (args: Record<string, string | boolean | number>) =>
  fauxAssistantMessage([fauxToolCall("start_subtask", args)], { stopReason: "toolUse" });

test(
  "task subtasks are joined before review and do not publish a second Home report",
  { timeout: 10_000 },
  async () => {
    const { fixture, models, options } = setup();
    const task = createIssue(fixture.userId, fixture.agentId, {
      title: "Verify migration",
      description: "Check the evidence",
      criteria: [],
      priority: "normal",
    });
    const attemptId = `attempt_${crypto.randomUUID()}`;
    db.update(sessions).set({ issueId: task.id }).where(eq(sessions.id, fixture.sessionId)).run();
    db.update(issues)
      .set({ sessionId: fixture.sessionId, status: "in_progress" })
      .where(eq(issues.id, task.id))
      .run();
    db.insert(issueAttempts)
      .values({
        id: attemptId,
        issueId: task.id,
        sessionId: fixture.sessionId,
        instructions: "",
        brief: "Verify",
        outcome: "running",
        createdAt: Date.now(),
      })
      .run();
    const addons = issueRunAddons(task.id, attemptId);
    let subtaskId = 0;
    let release!: () => void;
    const research = new Promise<void>((resolve) => {
      release = resolve;
    });
    const respond = async (context: import("@earendil-works/pi-ai").TranscriptContext) => {
      if (
        !context.messages.some(
          (message) =>
            message.role === "system" && JSON.stringify(message).includes('"name":"report_task"'),
        )
      ) {
        await research;
        return fauxAssistantMessage("Verified evidence from the subtask.");
      }
      const result = context.messages.findLast((message) => message.role === "toolResult");
      if (!result || result.role !== "toolResult")
        return call({
          name: "Database check",
          task: "Verify the database evidence",
          background: true,
        });
      if (result.toolName === "start_subtask") {
        subtaskId = JSON.parse((result.content[0] as { text: string }).text).subtaskId;
        return fauxAssistantMessage(
          [
            fauxToolCall("report_task", {
              state: "done",
              summary: "Complete",
              evidence: "Database checked",
            }),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (result.toolName === "report_task" && result.isError) {
        release();
        return fauxAssistantMessage([fauxToolCall("wait_subtask", { subtaskId })], {
          stopReason: "toolUse",
        });
      }
      if (result.toolName === "wait_subtask")
        return fauxAssistantMessage(
          [
            fauxToolCall("report_task", {
              state: "done",
              summary: "Complete",
              evidence: "Verified evidence from the subtask",
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("Ready for your review.");
    };
    models.faux.setResponses(Array.from({ length: 15 }, () => respond));
    const pi = await openTestHarness(fixture.sessionId, {
      ...options,
      tools: [...options.tools, ...addons.tools],
    });
    try {
      await pi.prompt("Complete the task using a background subtask");
      assert.equal((await readHelpers(pi.session))[0]?.status, "done");
      const results = (await pi.branch()).flatMap((entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "report_task"
          ? [entry.message]
          : [],
      );
      assert.deepEqual(
        results.map((result) => result.isError),
        [true, false],
      );
      assert.match(JSON.stringify(results[0]), /Subtasks are still running/);
      assert.equal(
        db
          .select()
          .from(homeEvents)
          .all()
          .filter((event) => event.sourceKey.includes(`helper:${fixture.sessionId}:`)).length,
        0,
      );
      assert.equal(db.select().from(issues).where(eq(issues.id, task.id)).get()?.verdict, "done");
    } finally {
      release();
      await pi.close();
    }
  },
);

test("stopping a task cancels its native background subtasks", async () => {
  const { fixture, models, options } = setup();
  models.faux.setResponses([
    call({ name: "Waiting", task: "Read later", background: true, wakeAt: Date.now() + 60_000 }),
    fauxAssistantMessage("Started."),
  ]);
  const pi = await openTestHarness(fixture.sessionId, options);
  try {
    await pi.prompt("Start research");
    await issueRunAddons("task", "attempt").onRunSettling!(pi.session, true);
    assert.equal((await readHelpers(pi.session))[0]?.status, "stopped");
    assert.equal(await hasPendingPiSessionWork(fixture.sessionId, true), false);
  } finally {
    await pi.close();
  }
});

test("foreground helpers return their result, inherit only read tools, and cannot delegate", async () => {
  const { fixture, models, options } = setup();
  const write: ToolRegistration = {
    name: "write",
    description: "must not reach a helper",
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "write" }] }),
  };
  models.faux.setResponses([
    call({ name: "reader", task: "Inspect the evidence" }),
    fauxAssistantMessage("Evidence from the helper"),
    fauxAssistantMessage("Parent result"),
  ]);
  const pi = await openTestHarness(fixture.sessionId, {
    ...options,
    tools: [...options.tools, write],
  });
  try {
    await pi.prompt("Use a foreground helper");
    const [helper] = await readHelpers(pi.session);
    assert.equal(helper?.status, "done");
    assert.equal(helper.answer, "Evidence from the helper");
    const child = (await pi.session.native.conversation(
      helper.id as ConversationId,
      TEST_CONTEXT,
    ))!;
    assert.ok(
      (await child.agent(TEST_CONTEXT)).tools.every(
        (tool) => tool.name !== "write" && tool.name !== "start_subtask",
      ),
    );
  } finally {
    await pi.close();
  }
});

test("background sleep survives reopen, parent stop leaves it running, and its result is reported once", async () => {
  const { fixture, models, options } = setup();
  models.faux.setResponses([
    call({
      name: "later",
      task: "Return the research",
      background: true,
      wakeAt: Date.now() + 400,
    }),
    fauxAssistantMessage("I will keep working"),
    fauxAssistantMessage("Saved background result"),
  ]);
  let pi = await openTestHarness(fixture.sessionId, options);
  try {
    await pi.prompt("Start background research");
    assert.equal(await hasPendingPiSessionWork(fixture.sessionId), false);
    assert.equal(await hasPendingPiSessionWork(fixture.sessionId, true), true);
    await pi.session.conversation.abort(TEST_CONTEXT);
    assert.ok(
      (await pi.session.native.inspect(TEST_CONTEXT)).tasks.some(
        (task) => task.state.kind === "sleeping",
      ),
    );
    await pi.close();
    pi = await openTestHarness(fixture.sessionId, options);
    await pi.session.native.waitForTask(
      (await readHelpers(pi.session))[0]!.reporterId as TaskId,
      TEST_CONTEXT,
    );
    assert.equal((await readHelpers(pi.session))[0]?.answer, "Saved background result");
    const notices = (await pi.branch()).filter(
      (entry) => entry.type === "message" && entry.message.role === "homeNotice",
    );
    assert.equal(notices.length, 0);
    const count = db
      .select()
      .from(homeEvents)
      .all()
      .filter((event) => event.sourceKey.includes(`helper:${fixture.sessionId}:`)).length;
    assert.equal(count, 1);
    await pi.close();
    pi = await openTestHarness(fixture.sessionId, options);
    await pi.session.native.waitForIdle(TEST_CONTEXT);
    assert.equal(
      (await pi.branch()).filter(
        (entry) => entry.type === "message" && entry.message.role === "homeNotice",
      ).length,
      0,
    );
  } finally {
    await pi.close();
  }
});

test("stopping a sleeping helper prevents its future input", async () => {
  const { fixture, models, options } = setup();
  models.faux.setResponses([
    call({
      name: "waiting",
      task: "Do not run this",
      background: true,
      wakeAt: Date.now() + 60000,
    }),
    fauxAssistantMessage("Scheduled"),
  ]);
  const pi = await openTestHarness(fixture.sessionId, options);
  try {
    await pi.prompt("Start delayed helper");
    const [helper] = await readHelpers(pi.session);
    assert.ok(helper);
    await stopHelper(pi.session, helper.id);
    await pi.session.native.waitForIdle(TEST_CONTEXT);
    assert.equal((await readHelpers(pi.session))[0]?.status, "stopped");
    assert.equal((await pi.session.native.inspect(TEST_CONTEXT)).tasks.length, 0);
  } finally {
    await pi.close();
  }
});

test("helper read permission is rechecked at execution", async () => {
  const { fixture, models, options } = setup();
  let reads = 0;
  const read: ToolRegistration = {
    name: "read",
    description: "read evidence",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      reads++;
      return { output: [{ type: "text", text: "evidence" }] };
    },
  };
  models.faux.setResponses([
    call({ name: "guarded", task: "Read evidence", background: true, wakeAt: Date.now() + 250 }),
    fauxAssistantMessage("Working later"),
    fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("Read was unavailable"),
  ]);
  const pi = await openTestHarness(fixture.sessionId, {
    ...options,
    tools: [...options.tools, read],
  });
  try {
    await pi.prompt("Start permission check");
    const row = db.select().from(agents).where(eq(agents.id, fixture.agentId)).get()!;
    db.update(agents)
      .set({ permissions: { ...row.permissions, read: false } })
      .where(eq(agents.id, row.id))
      .run();
    await pi.session.native.waitForTask(
      (await readHelpers(pi.session))[0]!.reporterId as TaskId,
      TEST_CONTEXT,
    );
    assert.equal(reads, 0);
    const helper = (await readHelpers(pi.session))[0]!;
    assert.equal(helper.answer, "Read was unavailable");
  } finally {
    await pi.close();
  }
});

test("the helper execution deadline is retained across reopen", async () => {
  const { fixture, models, options } = setup();
  models.faux.setResponses([
    call({
      name: "expired",
      task: "Do not execute expired work",
      background: true,
      wakeAt: Date.now() + 250,
    }),
    fauxAssistantMessage("Waiting"),
  ]);
  let pi = await openTestHarness(fixture.sessionId, options);
  try {
    await pi.prompt("Start a helper with an expired budget");
    const helper = (await readHelpers(pi.session))[0]!;
    await pi.session.native.commit(async (tx) => {
      (await tx.doc(Helpers)).items[String(helper.id)]!.deadline = 0;
    }, TEST_CONTEXT);
    await pi.close();
    pi = await openTestHarness(fixture.sessionId, options);
    await pi.session.native.waitForTask(helper.reporterId as TaskId, TEST_CONTEXT);
    const expired = (await readHelpers(pi.session))[0]!;
    assert.equal(expired.status, "failed");
    assert.match(expired.answer!, /five-minute limit/);
  } finally {
    await pi.close();
  }
});

test("helper routes keep child transcripts private and stop only the selected session's helper", async () => {
  const { fixture, models, options } = setup();
  models.faux.setResponses([
    call({
      name: "private",
      task: "Private delayed research",
      background: true,
      wakeAt: Date.now() + 60000,
    }),
    fauxAssistantMessage("Scheduled"),
  ]);
  const pi = await openTestHarness(fixture.sessionId, options);
  let userId = createUser();
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", db.select().from(users).where(eq(users.id, userId)).get()!);
    await next();
  });
  app.route("/", createHelperRoutes());
  try {
    await pi.prompt("Create a private helper");
    const helper = (await readHelpers(pi.session))[0]!;
    const path = `/sessions/${fixture.sessionId}/helpers`;
    for (const [url, method] of [
      [path, "GET"],
      [`${path}/${helper.id}`, "GET"],
      [`${path}/stop`, "POST"],
      [`${path}/${helper.id}/stop`, "POST"],
      [`${path}/resume`, "POST"],
    ])
      assert.equal((await app.request(url!, { method })).status, 404);
    userId = fixture.userId;
    assert.equal((await app.request(path)).status, 200);
    assert.equal((await app.request(`${path}/${helper.id}`)).status, 200);
    assert.equal((await app.request(`${path}/999999`)).status, 404);
    assert.equal((await app.request(`${path}/${helper.id}/stop`, { method: "POST" })).status, 200);
    assert.equal((await readHelpers(pi.session))[0]?.status, "stopped");
  } finally {
    await pi.close();
  }
});
