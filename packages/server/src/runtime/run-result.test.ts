import { readHelpers } from "./helpers.ts";
import { resumeHelperHost, shutdownHelperHosts, startHelperHosts } from "./helper-hosts.ts";
import type { TaskId } from "@earendil-works/pi-durable";
import { helperHosts, homeEvents } from "../db/schema.ts";
import { readHome } from "../services/agent-homes.ts";
import { drainHomeEvents } from "../services/home-events.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { AgentRunResult } from "@carmel-agent/shared";
import { db, initialize, sqlite } from "../db/index.ts";
import {
  agents,
  agentTasks,
  knowledgeConfigs,
  knowledgeSources,
  modelRefs,
  sessions,
} from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { imBindings, imCredentials, imIntegrations, imOutbox } from "../db/im-schema.ts";
import { encryptIm } from "../services/im-integrations.ts";
import { createAgentTask, readAgentTask, readTaskRuns } from "../services/agent-tasks.ts";
import { runTaskNow } from "./task-scheduler.ts";
import { ImManager, receiveImMessage } from "./im-manager.ts";
import { resolveModelContext } from "../services/model-context.ts";
import { loadSession } from "../services/session-store.ts";
import { closePiSession, openPiSession } from "../services/pi-session-storage.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAgent, createUser } from "../test-support.ts";
import { answerQuestion, readUserRequests } from "../services/user-requests.ts";
import { readSessionConnection } from "../services/session-snapshot.ts";
import {
  abortAgentRun,
  admitAgentRun,
  startDetachedAgentRun,
  whenRunFinished,
} from "./agent-runtime.ts";
import { shutdownActiveRuns, type ActiveAgentRun } from "./run-stream.ts";

/**
 * How a real run ends, end to end: the runtime, Pi, and an OpenAI-compatible
 * provider on localhost that is told how to behave. Finishing is not the same
 * as succeeding, so every way a run can end is driven through the same path
 * chat and the scheduler use.
 */

initialize();

type ProviderMode =
  | "helper"
  | "question"
  | "reply"
  | "reject"
  | "tool-loop"
  | "hang"
  | "think"
  | "schedule"
  | "schedule-codemode"
  | "notify"
  | "notify-codemode"
  | "knowledge"
  | "knowledge-codemode";
const provider = await startFakeProvider();
after(() => provider.close());

test("a run that gets its reply succeeds", async () => {
  const run = await startRun("reply");
  assert.deepEqual(await finished(run), { outcome: "succeeded" });
});

test("a background helper survives parent finalization and server host reopen with one Home report", async () => {
  startHelperHosts();
  const run = await startRun("helper");
  try {
    assert.deepEqual(await finished(run), { outcome: "succeeded" });
    assert.ok(db.select().from(helperHosts).where(eq(helperHosts.sessionId, run.sessionId)).get());
    await shutdownHelperHosts();
    provider.mode = "reply";
    startHelperHosts();
    await resumeHelperHost(run.sessionId);
    const pi = await openPiSession(run.sessionId);
    try {
      const [helper] = await readHelpers(pi);
      assert.ok(helper?.reporterId);
      await pi.native.waitForTask(helper.reporterId as TaskId, BACKGROUND_CONTEXT);
      assert.equal((await readHelpers(pi))[0]?.status, "done");
      assert.equal((await readHelpers(pi))[0]?.answer, "Hi there.");
      const reports = () =>
        db
          .select()
          .from(homeEvents)
          .all()
          .filter((event) => event.sourceKey.includes(`helper:${run.sessionId}:`));
      assert.equal(reports().length, 1);
      await resumeHelperHost(run.sessionId);
      assert.equal(reports().length, 1);
      assert.ok(readHome(run.userId, (await loadSession(run.sessionId))!.agentId));
    } finally {
      await closePiSession(pi);
    }
  } finally {
    await shutdownHelperHosts();
  }
});

test("the server runtime ends for a question and delivers its saved answer on the next run", async () => {
  const run = await startRun("question");
  assert.deepEqual(await finished(run), { outcome: "succeeded" });
  const snapshot = await readSessionConnection(run.userId, run.sessionId);
  assert.equal(snapshot?.pendingWork, false);
  const request = snapshot?.userRequests?.[0];
  assert.equal(request?.status, "pending");
  assert.equal(request?.kind, "question");
  answerQuestion(run.userId, run.sessionId, request!.id, { selected: ["main"] });
  provider.mode = "reply";
  const session = (await loadSession(run.sessionId))!;
  const model = await resolveModelContext(run.userId, session.modelRefId);
  assert.ok(model.ok);
  const resumed = startDetachedAgentRun({
    agent: db.select().from(agents).where(eq(agents.id, session.agentId)).get()!,
    session,
    modelRef: model.value.modelRef,
    providerConfig: model.value.providerConfig,
    modelRuntime: model.value.modelRuntime,
    thinkingLevel: "off",
  });
  assert.deepEqual(await finished(resumed), { outcome: "succeeded" });
  assert.equal(readUserRequests(session.id)[0]?.delivery, "submitted");
  const messages = (await loadSession(session.id))!.messages;
  assert.equal(messages.filter((message) => message.role === "user").length, 2);
  assert.match(JSON.stringify(messages), /Main/);
  assert.match(JSON.stringify(provider.requests.at(-1)), /Main/);
});

test("IM messages share private Home context and reset context while preserving its history", async () => {
  const previousKey = process.env.CARMEL_SECRET_KEY;
  const previousPublicUrl = process.env.CARMEL_PUBLIC_URL;
  process.env.CARMEL_PUBLIC_URL = "https://carmel.example.test/app/";
  process.env.CARMEL_SECRET_KEY = "im-conversation-fixture-key";
  const sent: string[] = [];
  const manager = new ImManager(() => ({
    async start() {},
    stop() {},
    async image() {
      throw new Error("No images in this scenario.");
    },
    async send(_chat, text) {
      sent.push(text);
      return `reply-${sent.length}`;
    },
  }));
  try {
    const initial = await startRun("reply");
    await finished(initial);
    const source = db.select().from(sessions).where(eq(sessions.id, initial.sessionId)).get()!;
    assert.ok(
      provider.systemPrompts
        .at(-1)
        ?.includes(`https://carmel.example.test/app/agents/${source.agentId}/home`),
    );
    const integrationId = id("im_conversation");
    db.insert(imIntegrations)
      .values({
        id: integrationId,
        userId: source.userId,
        agentId: source.agentId,
        platform: "telegram",
        botId: integrationId,
        botName: "Conversation fixture",
        status: "connected",
        updatedAt: now(),
      })
      .run();
    db.insert(imCredentials)
      .values({ integrationId, value: encryptIm({ token: "unused" }) })
      .run();
    db.insert(imBindings).values({ integrationId, senderId: "person", chatId: "chat" }).run();
    let event = 0;
    const send = async (text: string) => {
      await receiveImMessage(integrationId, {
        eventId: String(event++),
        senderId: "person",
        chatId: "chat",
        text,
        imageKeys: [],
      });
      await manager.tick();
      await manager.drain();
      await drainHomeEvents();
      await manager.tick();
      await manager.drain();
    };
    const binding = () => readHome(source.userId, source.agentId)!;
    await send("First private IM prompt");
    const firstSessionId = binding().sessionId!;
    assert.notEqual(firstSessionId, source.id);
    assert.equal((await loadSession(firstSessionId))!.userId, source.userId);
    assert.ok(sent.includes("Hi there."));
    assert.ok(
      provider.systemPrompts
        .at(-1)
        ?.includes(`https://carmel.example.test/app/agents/${source.agentId}/home`),
    );
    delete process.env.CARMEL_PUBLIC_URL;
    await send("Continue this conversation");
    assert.match(
      provider.systemPrompts.at(-1)!,
      /CARMEL_PUBLIC_URL is unavailable; keep Carmel links app-relative/,
    );
    assert.doesNotMatch(provider.systemPrompts.at(-1)!, /https:\/\/carmel\.example\.test/);
    assert.equal(binding().sessionId, firstSessionId);
    const first = await loadSession(firstSessionId);
    assert.match(JSON.stringify(first!.messages), /First private IM prompt/);
    assert.match(JSON.stringify(first!.messages), /Continue this conversation/);
    await send("/new");
    await send("A fresh conversation");
    assert.equal(binding().sessionId, firstSessionId);
    assert.ok(await loadSession(firstSessionId));
    assert.doesNotMatch(
      JSON.stringify(provider.requests.at(-1)),
      /First private IM prompt|Continue this conversation/,
    );
  } finally {
    manager.stop();
    if (previousKey === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previousKey;
    if (previousPublicUrl === undefined) delete process.env.CARMEL_PUBLIC_URL;
    else process.env.CARMEL_PUBLIC_URL = previousPublicUrl;
  }
});

test("ordinary, Codemode and fresh scheduled runs can enqueue a private notification without an IM conversation", async () => {
  const previousKey = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = "runtime-im-fixture-key";
  try {
    for (const codemodeEnabled of [false, true]) {
      const run = await startRun(codemodeEnabled ? "notify-codemode" : "notify", (sessionId) => {
        const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
        db.update(agents).set({ codemodeEnabled }).where(eq(agents.id, session.agentId)).run();
        const integrationId = id("im_fixture");
        db.insert(imIntegrations)
          .values({
            id: integrationId,
            userId: session.userId,
            agentId: session.agentId,
            platform: "telegram",
            botId: integrationId,
            botName: "Runtime fixture",
            status: "connected",
            updatedAt: now(),
          })
          .run();
        db.insert(imCredentials)
          .values({ integrationId, value: encryptIm({ token: "fixture_not_used" }) })
          .run();
        db.insert(imBindings).values({ integrationId, senderId: "person", chatId: "chat" }).run();
      });
      assert.deepEqual(await finished(run), { outcome: "succeeded" });
      const session = db.select().from(sessions).where(eq(sessions.id, run.sessionId)).get()!;
      const [firstDelivery] = db
        .select()
        .from(imOutbox)
        .where(eq(imOutbox.sessionId, session.id))
        .all();
      assert.equal(firstDelivery?.text, "Your build failed.");
      assert.equal(firstDelivery?.status, "pending");
      const user = { id: session.userId, role: "user" as const };
      const task = createAgentTask(user, session.agentId, {
        name: "Build alert",
        prompt: "Send the build alert when run.",
        scheduleKind: "interval",
        scheduleValue: "60000",
        notifyPlatform: "telegram",
      });
      const requestIndex = provider.systemPrompts.length;
      const started = await runTaskNow(readAgentTask(user, session.agentId, task.id));
      assert.equal(started.outcome, "running");
      const deadline = Date.now() + 15_000;
      while (
        readTaskRuns(user, session.agentId, task.id)[0]?.outcome === "running" &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      const [taskRun] = readTaskRuns(user, session.agentId, task.id);
      assert.equal(taskRun?.outcome, "succeeded");
      assert.notEqual(taskRun.sessionId, session.id);
      assert.equal(taskRun.deliveries?.[0]?.status, "pending");
      assert.match(
        provider.systemPrompts.slice(requestIndex).join("\n"),
        /saved notification destination is telegram/,
      );
      assert.equal(
        db
          .select()
          .from(imBindings)
          .where(eq(imBindings.integrationId, firstDelivery.integrationId))
          .get()!.sessionId,
        null,
      );
    }
  } finally {
    if (previousKey === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previousKey;
  }
});

test("successive named-session runs preserve the provider request prefix without injecting a clock", async (t) => {
  const firstRequest = provider.requests.length;
  const first = await startRun("reply");
  assert.equal((await finished(first)).outcome, "succeeded");
  const pi = await openPiSession(first.sessionId);
  try {
    const before = await pi.conversation.entries(
      { order: "ascending" },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const initial = before.items
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "system");
    assert.equal(initial.length, 1);
    assert.ok(initial[0]!.sections?.system);
    assert.ok(initial[0]!.sections?.cwd);
    assert.ok(initial[0]!.sections?.scheduling);
    assert.equal(initial[0]!.sections?.clock, undefined);
    const reads = t.mock.method(pi.conversation, "entries");
    const session = (await loadSession(first.sessionId))!;
    const context = await resolveModelContext(session.userId, session.modelRefId);
    assert.ok(context.ok);
    const second = startDetachedAgentRun({
      agent: db.select().from(agents).where(eq(agents.id, session.agentId)).get()!,
      session,
      modelRef: context.value.modelRef,
      providerConfig: context.value.providerConfig,
      modelRuntime: context.value.modelRuntime,
      thinkingLevel: "off",
      promptInput: { text: "Hello again" },
      timezone: "Asia/Singapore",
    });
    assert.equal((await finished(second)).outcome, "succeeded");
    assert.equal(reads.mock.callCount(), 0, "an existing title needs no history sample");
    const after = await pi.conversation.entries(
      { order: "ascending" },
      100,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const systems = after.items
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "system");
    assert.equal(systems.length, 1, "unchanged instructions need no new native system entry");
    const [firstPayload, secondPayload] = provider.requests.slice(firstRequest);
    assert.ok(firstPayload && secondPayload);
    assert.deepEqual(
      secondPayload.messages.slice(0, firstPayload.messages.length),
      firstPayload.messages,
    );
    assert.deepEqual(secondPayload.tools, firstPayload.tools);
    assert.equal(
      firstPayload.messages.find((message) => message.role === "user")!.content,
      "Hello",
    );
    assert.equal(secondPayload.messages.at(-1)!.content, "Hello again");
    assert.doesNotMatch(firstPayload.messages[0]!.content, /Current time: \d{4}-|<current_time>/);
  } finally {
    await closePiSession(pi);
  }
});

test("ordinary and Codemode chat calls persist a scheduled reminder and return its confirmation", async () => {
  for (const codemodeEnabled of [false, true]) {
    const firstRequest = provider.systemPrompts.length;
    const run = await startRun(codemodeEnabled ? "schedule-codemode" : "schedule", (sessionId) => {
      const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
      db.update(agents).set({ codemodeEnabled }).where(eq(agents.id, session.agentId)).run();
    });
    assert.deepEqual(await finished(run), { outcome: "succeeded" });
    const session = (await loadSession(run.sessionId))!;
    const tasks = db.select().from(agentTasks).where(eq(agentTasks.agentId, session.agentId)).all();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].userId, run.userId);
    assert.equal(tasks[0].modelRefId, session.modelRefId);
    assert.equal(tasks[0].nextRunAt, Date.parse("2099-01-01T01:00:00Z"));
    assert.match(JSON.stringify(session.messages), /Tasks run history/);
    const prompt = provider.systemPrompts
      .slice(firstRequest)
      .find((text) => text.includes("Current working directory:"))!;
    assert.doesNotMatch(prompt, /Current time: \d{4}-|<current_time>/);
    assert.match(prompt, /check the current time with bash if available/);
    assert.match(prompt, /browser time zone: Asia\/Singapore/);
    assert.match(prompt, /use schedule_task/);
  }
});

test("the model sees runner paths for its cwd, project instructions, and workspace skills", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-run-paths-"));
  mkdirSync(join(workingDir, ".agents", "skills", "review"), { recursive: true });
  writeFileSync(join(workingDir, "AGENTS.md"), "Review the project.");
  writeFileSync(
    join(workingDir, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review changes\n---\nRead the source.",
  );
  const firstRequest = provider.systemPrompts.length;
  try {
    const run = await startRun("reply", (sessionId) => {
      const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
      db.update(agents)
        .set({ workingDirMode: "default", workingDir })
        .where(eq(agents.id, session.agentId))
        .run();
    });
    assert.equal((await finished(run)).outcome, "succeeded");
    const prompt = provider.systemPrompts
      .slice(firstRequest)
      .find((text) => text.includes("Current working directory:"));
    assert.ok(prompt);
    assert.ok(prompt.includes("Current working directory: /workspace"));
    assert.ok(prompt.includes('path="/workspace/AGENTS.md"'));
    assert.ok(prompt.includes("/workspace/.agents/skills/review/SKILL.md"));
    assert.ok(!prompt.includes(workingDir));
  } finally {
    rmSync(workingDir, { recursive: true, force: true });
  }
});

test("ordinary and Codemode runs send current knowledge context and load the guide on demand", async () => {
  for (const [codemodeEnabled, shared] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]) {
    const firstRequest = provider.systemPrompts.length;
    const firstPayload = provider.requests.length;
    const run = await startRun(
      codemodeEnabled ? "knowledge-codemode" : "knowledge",
      (sessionId) => {
        const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
        db.update(agents)
          .set({ codemodeEnabled, shared })
          .where(eq(agents.id, session.agentId))
          .run();
        db.insert(knowledgeConfigs)
          .values({
            agentId: session.agentId,
            settings: { enabled: true, acceleration: "cpu" },
            status: {
              state: "idle",
              lastUpdatedAt: null,
              documents: 0,
              needsEmbedding: 0,
              error: null,
              backend: null,
              devices: [],
            },
          })
          .run();
        db.insert(knowledgeSources)
          .values({
            id: id("source"),
            agentId: session.agentId,
            name: "Family vault",
            path: "/unavailable-vault",
            description: "Household budgets",
            createdAt: now(),
          })
          .run();
      },
    );
    assert.equal((await finished(run)).outcome, "succeeded");
    const prompt = provider.systemPrompts
      .slice(firstRequest)
      .find((text) => text.includes("Current working directory:"))!;
    assert.ok(prompt);
    assert.match(prompt, /## Knowledge and memory/);
    assert.match(prompt, /Family vault/);
    assert.match(prompt, /Household budgets/);
    assert.match(prompt, /use knowledge_search/);
    assert.match(prompt, /load_builtin_skill with name="knowledge-search"/);
    assert.match(prompt, /Memory is read-only/);
    const { loadBuiltinSkills } = await import("./builtin-skills.ts");
    const session = db.select().from(sessions).where(eq(sessions.id, run.sessionId)).get()!;
    const skill = (
      await loadBuiltinSkills(db.select().from(agents).where(eq(agents.id, session.agentId)).get()!)
    ).find((skill) => skill.name === "knowledge-search")!;
    assert.ok(skill);
    assert.ok(!prompt.includes(skill.content), "the workflow must not be injected at startup");
    assert.ok(
      provider.requests
        .slice(firstPayload)
        .some((payload) =>
          payload.messages.some(
            (message) =>
              message.role === "tool" && message.content.includes("Find and verify evidence"),
          ),
        ),
      "the guide must reach the model through a tool result, including nested Codemode calls",
    );
    if (shared) {
      assert.match(prompt, /shared across all of its users/);
      assert.doesNotMatch(prompt, /private agent and are available only to its owner/);
    } else {
      assert.match(prompt, /private agent and are available only to its owner/);
      assert.doesNotMatch(prompt, /shared across all of its users/);
    }
    assert.ok(!prompt.includes("/unavailable-vault"));
    assert.ok(
      !prompt.includes("Use memory_save"),
      "read-only agent must not be instructed to save",
    );
    assert.ok(!prompt.includes("Use memory_forget"));
  }
});

test("a provider rejection fails the run and says why", async () => {
  // The case that used to read as success: Pi turns the 401 into an assistant
  // message with stopReason "error", and nothing throws.
  const run = await startRun("reject");
  const result = await finished(run);
  assert.equal(result.outcome, "failed");
  assert.match(result.detail ?? "", /API key|401|auth/i);
});

test("a run guard stop fails the run with the guard's reason", async () => {
  const previous = process.env.CARMEL_AGENT_MAX_TOOL_CALLS;
  process.env.CARMEL_AGENT_MAX_TOOL_CALLS = "1";
  try {
    const run = await startRun("tool-loop");
    const result = await finished(run);
    assert.equal(result.outcome, "failed");
    assert.match(result.detail ?? "", /stopped after 1 tool calls/);
  } finally {
    if (previous === undefined) delete process.env.CARMEL_AGENT_MAX_TOOL_CALLS;
    else process.env.CARMEL_AGENT_MAX_TOOL_CALLS = previous;
  }
});

test("a run a person stops is cancelled", async () => {
  const run = await startRun("hang");
  await provider.waitForRequest();
  assert.ok(abortAgentRun(run.userId, run.runId));
  assert.deepEqual(await finished(run), { outcome: "cancelled" });
});

test("a stop before an admitted run starts never reaches the provider", async () => {
  const requestsBefore = provider.requests.length;
  const run = await startRun("think", undefined, { admit: true });
  try {
    assert.equal(provider.requests.length, requestsBefore);
    assert.ok(abortAgentRun(run.userId, run.runId));
    assert.deepEqual(await finished(run), { outcome: "cancelled" });
    assert.equal(provider.requests.length, requestsBefore);
  } finally {
    abortAgentRun(run.userId, run.runId);
  }
});

test("stopping during thinking cancels the run", async () => {
  const run = await startRun("think");
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !hasThinking(run)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(hasThinking(run), "thinking never started");
    assert.ok(abortAgentRun(run.userId, run.runId));
    assert.deepEqual(await finished(run), { outcome: "cancelled" });
  } finally {
    abortAgentRun(run.userId, run.runId);
  }
});

test("a run cut off by shutdown is interrupted", async () => {
  const run = await startRun("hang");
  await provider.waitForRequest();
  await shutdownActiveRuns();
  assert.equal((await finished(run)).outcome, "interrupted");
});

test("a run whose result cannot be saved fails", async () => {
  const run = await startRun("reply", (sessionId) => {
    // The session row is committed at finalization; make exactly that write fail.
    sqlite.exec(`
      CREATE TRIGGER fail_session_commit BEFORE UPDATE ON sessions
      WHEN NEW.id = '${sessionId}'
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
    `);
  });
  try {
    const result = await finished(run);
    assert.equal(result.outcome, "failed");
    assert.match(result.detail ?? "", /could not be saved: disk I\/O error/);
  } finally {
    sqlite.exec("DROP TRIGGER IF EXISTS fail_session_commit");
  }
});

function hasThinking(run: ActiveAgentRun) {
  return run.events.some((envelope) => JSON.stringify(envelope.event).includes("thinking"));
}

/** Waits for the run, and checks the stream's terminal event says the same thing. */
async function finished(run: ActiveAgentRun): Promise<AgentRunResult> {
  const result = await whenRunFinished(run, 20);
  const terminal = run.events.at(-1)?.event;
  assert.deepEqual(terminal, { type: "run_finished", result });
  return result;
}

async function startRun(
  mode: ProviderMode,
  beforeStart?: (sessionId: string) => void,
  options?: { admit?: boolean },
) {
  provider.mode = mode;
  const userId = createUser();
  const modelRefId = id("model_ref");
  const timestamp = now();
  db.insert(modelRefs)
    .values({
      id: modelRefId,
      ownerUserId: userId,
      label: "Fake",
      provider: "ollama",
      modelId: modelRefId,
      api: "openai-completions",
      baseUrl: `${provider.url}/v1`,
      input: ["text"],
      reasoning: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  const agentId = createAgent({ ownerUserId: userId, defaultModelRefId: modelRefId });
  const sessionId = id("session");
  db.insert(sessions)
    .values({
      id: sessionId,
      title: "Test",
      userId,
      agentId,
      modelRefId,
      thinkingLevel: "off",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();

  const context = await resolveModelContext(userId, modelRefId);
  assert.ok(context.ok, "the fake provider's model did not resolve");
  const session = await loadSession(sessionId);
  assert.ok(session);
  beforeStart?.(sessionId);
  const start = options?.admit ? admitAgentRun : startDetachedAgentRun;
  return start({
    agent: db.select().from(agents).where(eq(agents.id, agentId)).get()!,
    session,
    modelRef: context.value.modelRef,
    providerConfig: context.value.providerConfig,
    modelRuntime: context.value.modelRuntime,
    thinkingLevel: "off",
    promptInput: { text: "Hello" },
    timezone: "Asia/Singapore",
  });
}

async function startFakeProvider() {
  let waiters: Array<() => void> = [];
  const state = { mode: "reply" as ProviderMode };
  const systemPrompts: string[] = [];
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> =
    [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as (typeof requests)[number];
    requests.push(payload);
    systemPrompts.push(
      ...payload.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content),
    );
    for (const resolve of waiters) resolve();
    waiters = [];
    respond(
      state.mode,
      request,
      response,
      payload.messages.some((message) => message.role === "tool"),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    systemPrompts,
    requests,
    get mode() {
      return state.mode;
    },
    set mode(mode: ProviderMode) {
      state.mode = mode;
    },
    waitForRequest: () => new Promise<void>((resolve) => waiters.push(resolve)),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function respond(
  mode: ProviderMode,
  request: IncomingMessage,
  response: ServerResponse,
  hasToolResult: boolean,
) {
  if (mode === "reject") {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (mode === "hang") {
    // Headers and nothing else: a provider that accepted the request and went quiet.
    request.on("close", () => response.end());
    return;
  }
  const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "fake" };
  const chunk = (delta: object, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  if (mode === "question") {
    response.write(
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_question",
            type: "function",
            function: {
              name: "ask_user_question",
              arguments: JSON.stringify({
                question: "Which branch?",
                options: [{ id: "main", label: "Main" }],
                allowFreeText: false,
              }),
            },
          },
        ],
      }),
    );
    response.write(chunk({}, "tool_calls"));
    response.end("data: [DONE]\n\n");
    return;
  }
  if (mode === "think") {
    // Reasoning tokens until the client aborts. Stop has to cut this short.
    const timer = setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        clearInterval(timer);
        return;
      }
      response.write(chunk({ reasoning_content: "still thinking " }));
    }, 20);
    request.on("close", () => {
      clearInterval(timer);
      if (!response.writableEnded) response.end();
    });
    return;
  }
  if (mode === "helper" && !hasToolResult) {
    response.write(
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_helper",
            type: "function",
            function: {
              name: "start_subtask",
              arguments: JSON.stringify({
                name: "Research",
                task: "Summarize the evidence",
                background: true,
                wakeAt: Date.now() + 1000,
              }),
            },
          },
        ],
      }),
    );
    response.write(chunk({}, "tool_calls"));
  } else if ((mode === "knowledge" || mode === "knowledge-codemode") && !hasToolResult) {
    const args = { name: "knowledge-search" };
    const call =
      mode === "knowledge"
        ? { name: "load_builtin_skill", arguments: JSON.stringify(args) }
        : {
            name: "codemode",
            arguments: JSON.stringify({
              code: `text(await tools.load_builtin_skill(${JSON.stringify(args)}));`,
            }),
          };
    response.write(
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_knowledge", type: "function", function: call }],
      }),
    );
    response.write(chunk({}, "tool_calls"));
  } else if ((mode === "notify" || mode === "notify-codemode") && !hasToolResult) {
    const args = { text: "Your build failed.", platform: "telegram" };
    const call =
      mode === "notify"
        ? { name: "send_user_message", arguments: JSON.stringify(args) }
        : {
            name: "codemode",
            arguments: JSON.stringify({
              code: `text(await tools.send_user_message(${JSON.stringify(args)}));`,
            }),
          };
    response.write(
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_notify", type: "function", function: call }],
      }),
    );
    response.write(chunk({}, "tool_calls"));
  } else if ((mode === "schedule" || mode === "schedule-codemode") && !hasToolResult) {
    const args = {
      name: "Report reminder",
      prompt: "Remind the user to submit the report.",
      scheduleKind: "once",
      scheduleValue: "2099-01-01T09:00:00+08:00",
    };
    const call =
      mode === "schedule"
        ? { name: "schedule_task", arguments: JSON.stringify(args) }
        : {
            name: "codemode",
            arguments: JSON.stringify({
              code: `text(await tools.schedule_task(${JSON.stringify(args)}));`,
            }),
          };
    response.write(
      chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_schedule", type: "function", function: call }],
      }),
    );
    response.write(chunk({}, "tool_calls"));
  } else if (mode === "tool-loop") {
    // Asks for the same tool every turn, so only the guard ends the run.
    response.write(
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${Date.now()}`,
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "missing.txt" }) },
          },
        ],
      }),
    );
    response.write(chunk({}, "tool_calls"));
  } else {
    response.write(chunk({ role: "assistant", content: "Hi there." }));
    response.write(chunk({}, "stop"));
  }
  response.end("data: [DONE]\n\n");
}
