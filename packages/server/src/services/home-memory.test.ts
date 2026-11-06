import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { AuthVariables } from "../auth.ts";
import { db, initialize, sqlite } from "../db/index.ts";
import {
  agents,
  homeEvents,
  homeMemoryCaptures,
  homeMemoryRevisions,
  modelRefs,
  users,
} from "../db/schema.ts";
import { createSession, createUser } from "../test-support.ts";
import { ensureHome, resetHome } from "./agent-homes.ts";
import { createHomeMemoryRoutes } from "../routes/home-memory.ts";
import { openTestHarness, fauxHarnessModels } from "../effectors/testing/pi-harness.ts";
import {
  activeHomeMemories,
  readHomeMemoryOverview,
  readHomeMemorySettings,
  setHomeMemorySettings,
  saveHomeMemory,
  editHomeMemory,
  forgetHomeMemory,
  searchHomeMemories,
  homeMemoryHistory,
  restoreHomeMemory,
  invalidateHomeMemorySources,
} from "./home-memory.ts";
import {
  buildHomeMemoryContext,
  createHomeMemoryTools,
  humanHomeMemoryEvent,
} from "../runtime/home-memory-tools.ts";
import {
  recordHomeMemoryInput,
  commitHomeCapture,
  parseHomeCaptureResult,
  captureHomeMemories,
  type HomeMemoryCandidate,
} from "./home-memory-capture.ts";

initialize();

function fixture() {
  const value = createSession();
  const home = ensureHome(value.userId, value.agentId);
  return { ...value, sessionId: home.sessionId };
}
function source(
  value: ReturnType<typeof fixture>,
  text: string,
  origin: "web" | "im" | "background" = "web",
) {
  const stamp = Date.now() + 10;
  return db
    .insert(homeEvents)
    .values({
      id: crypto.randomUUID(),
      sessionId: value.sessionId,
      sourceKey: crypto.randomUUID(),
      kind: origin === "background" ? "issue" : "input",
      origin,
      prompt: { text },
      status: "done",
      createdAt: stamp,
      finishedAt: stamp,
    })
    .returning()
    .get();
}
function candidate(
  event: typeof homeEvents.$inferSelect,
  changes: Partial<HomeMemoryCandidate> = {},
): HomeMemoryCandidate {
  return {
    content: "The user prefers minimal labels in Carmel interfaces.",
    kind: "preference",
    scope: "Carmel UI",
    slot: "carmel/ui/labels",
    eventId: event.id,
    evidence: event.prompt.text,
    futureUse: "Choosing labels for another Carmel screen.",
    ...changes,
  };
}
function appFor(userId: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", db.select().from(users).where(eq(users.id, userId)).get()!);
    await next();
  });
  app.route("/", createHomeMemoryRoutes());
  return app;
}

test("Home memory remains private between users of the same shared agent, including API and search", async () => {
  const value = fixture();
  db.update(agents).set({ shared: true }).where(eq(agents.id, value.agentId)).run();
  const other = createUser();
  ensureHome(other, value.agentId);
  const note = saveHomeMemory(value.userId, value.agentId, {
    content: "Private Saffron deployment choice",
  });
  assert.equal(readHomeMemoryOverview(other, value.agentId).total, 0);
  assert.deepEqual(searchHomeMemories(other, value.agentId, "Saffron"), []);
  assert.throws(
    () =>
      editHomeMemory(other, value.agentId, note.id, { content: "changed", expectedRevision: 1 }),
    /not found/,
  );
  const app = appFor(other);
  assert.equal(
    (await app.request(`/agents/${value.agentId}/home/memory/${note.id}/history`)).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/agents/${value.agentId}/home/memory/${note.id}?revision=1`, {
        method: "DELETE",
      })
    ).status,
    404,
  );
  assert.equal(searchHomeMemories(value.userId, value.agentId, "Saffron")[0]?.id, note.id);
});

test("manual mode is default; human Home provenance alone enables tools; Off removes recall and tools", () => {
  const value = fixture();
  const human = source(value, "Remember my Saffron deployment choice");
  const background = source(value, "Remember my Saffron deployment choice", "background");
  saveHomeMemory(value.userId, value.agentId, { content: "Saffron deployment choice" });
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).mode, "manual");
  recordHomeMemoryInput(human, "durable:1");
  assert.equal(
    db.select().from(homeMemoryCaptures).where(eq(homeMemoryCaptures.eventId, human.id)).get(),
    undefined,
  );
  assert.equal(
    createHomeMemoryTools(value.userId, value.agentId, value.sessionId, human.id).length,
    4,
  );
  assert.deepEqual(
    createHomeMemoryTools(value.userId, value.agentId, value.sessionId, background.id),
    [],
  );
  assert.deepEqual(
    createHomeMemoryTools(value.userId, value.agentId, "ordinary-session", human.id),
    [],
  );
  assert.equal(
    humanHomeMemoryEvent(value.userId, value.agentId, value.sessionId, background.id),
    undefined,
  );
  setHomeMemorySettings(value.userId, value.agentId, { mode: "off" });
  assert.deepEqual(
    createHomeMemoryTools(value.userId, value.agentId, value.sessionId, human.id),
    [],
  );
  assert.equal(buildHomeMemoryContext(value.userId, value.agentId, "Saffron", 100000), "");
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 1);
});

test("pinning preserves note fields, enforces the token budget, and topical recall stays bounded", () => {
  const value = fixture();
  const note = saveHomeMemory(value.userId, value.agentId, {
    content: "Use minimal labels.",
    scope: "Carmel",
    kind: "preference",
    expiresAt: Date.now() + 86400000,
  });
  const pinned = editHomeMemory(value.userId, value.agentId, note.id, {
    expectedRevision: note.revision,
    pinned: true,
  });
  assert.equal(pinned.scope, "Carmel");
  assert.equal(pinned.kind, "preference");
  assert.equal(pinned.expiresAt, note.expiresAt);
  for (let index = 0; index < 10; index++)
    saveHomeMemory(value.userId, value.agentId, {
      content: `Saffron deployment detail ${index}: ${"unique information ".repeat(50)}`,
    });
  const context = buildHomeMemoryContext(value.userId, value.agentId, "Saffron", 100000);
  const recalled = JSON.parse(context.split("\n").at(-1)!);
  assert.ok(recalled.length <= 5);
  assert.ok(estimateTextTokens(JSON.stringify(recalled)) < 1500);
  assert.equal(
    JSON.parse(
      buildHomeMemoryContext(value.userId, value.agentId, "unrelated penguins", 100000)
        .split("\n")
        .at(-1)!,
    ).length,
    1,
  );
  const large = saveHomeMemory(value.userId, value.agentId, {
    content: "long information ".repeat(110),
  });
  assert.throws(
    () =>
      editHomeMemory(value.userId, value.agentId, large.id, { expectedRevision: 1, pinned: true }),
    /500 tokens/,
  );
});

test("revision-safe edits and forgetting purge search and all revision text", () => {
  const value = fixture();
  const note = saveHomeMemory(value.userId, value.agentId, { content: "Saffron uses PostgreSQL" });
  const edited = editHomeMemory(value.userId, value.agentId, note.id, {
    expectedRevision: 1,
    content: "Saffron uses SQLite",
  });
  assert.equal(homeMemoryHistory(value.userId, value.agentId, note.id).length, 2);
  assert.throws(
    () =>
      editHomeMemory(value.userId, value.agentId, note.id, {
        expectedRevision: 1,
        content: "stale",
      }),
    /changed/,
  );
  assert.throws(() => forgetHomeMemory(value.userId, value.agentId, note.id, 1), /changed/);
  const restored = restoreHomeMemory(value.userId, value.agentId, note.id, 1, edited.revision);
  assert.equal(restored.content, note.content);
  forgetHomeMemory(value.userId, value.agentId, note.id, restored.revision);
  assert.deepEqual(searchHomeMemories(value.userId, value.agentId, "Saffron"), []);
  assert.equal(
    db.select().from(homeMemoryRevisions).where(eq(homeMemoryRevisions.memoryId, note.id)).all()
      .length,
    0,
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) AS count FROM home_memory_search WHERE memory_id = ?")
        .get(note.id) as { count: number }
    ).count,
    0,
  );
});

test("expired notes are inspectable but never recalled; secrets are not stored", () => {
  const value = fixture();
  saveHomeMemory(value.userId, value.agentId, {
    content: "Saffron old deadline",
    expiresAt: Date.now() - 1,
  });
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 1);
  assert.deepEqual(searchHomeMemories(value.userId, value.agentId, "Saffron"), []);
  assert.throws(
    () => saveHomeMemory(value.userId, value.agentId, { content: "password: super-secret" }),
    /Secrets/,
  );
});

test("native Home input admission binds capture to an exact message and reset preserves recall", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For Carmel, I prefer minimal UI labels.");
  const models = fauxHarnessModels();
  models.faux.setResponses([fauxAssistantMessage("Understood.")]);
  const harness = await openTestHarness(value.sessionId, models);
  try {
    await harness.harness.prompt(event.prompt.text, undefined, harness.context, undefined, {
      requestId: `home:${event.id}`,
      source: { homeEventId: event.id, origin: "web" },
      onSubmitted: (entryId) => recordHomeMemoryInput(event, entryId),
    });
    const captured = db
      .select()
      .from(homeMemoryCaptures)
      .where(eq(homeMemoryCaptures.eventId, event.id))
      .get();
    assert.ok(captured);
    assert.match(captured.entryId, /^durable:\d+$/);
    const saved = commitHomeCapture(
      value.userId,
      value.agentId,
      captured.generation,
      [event],
      [candidate(event)],
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.sourceEntryId, captured.entryId);
    assert.equal(
      commitHomeCapture(
        value.userId,
        value.agentId,
        captured.generation,
        [event],
        [candidate(event)],
      ).length,
      0,
    );
  } finally {
    await harness.close();
  }
  await resetHome(value.userId, value.agentId);
  assert.match(
    buildHomeMemoryContext(value.userId, value.agentId, "Carmel", 100000),
    /minimal labels/,
  );
});

test("capture rejects forged evidence, questions, background notices and results pending before forget", () => {
  const value = fixture();
  const settings = setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For Carmel, I prefer minimal UI labels.");
  recordHomeMemoryInput(event, "durable:1");
  assert.deepEqual(
    commitHomeCapture(
      value.userId,
      value.agentId,
      settings.generation,
      [event],
      [candidate(event, { evidence: "These words were never said." })],
    ),
    [],
  );
  const question = source(value, "Could I prefer minimal labels?");
  recordHomeMemoryInput(question, "durable:2");
  assert.deepEqual(
    commitHomeCapture(
      value.userId,
      value.agentId,
      settings.generation,
      [question],
      [candidate(question)],
    ),
    [],
  );
  const background = source(value, event.prompt.text, "background");
  recordHomeMemoryInput(background, "durable:3");
  assert.equal(
    db.select().from(homeMemoryCaptures).where(eq(homeMemoryCaptures.eventId, background.id)).get(),
    undefined,
  );
  const pending = source(value, event.prompt.text);
  recordHomeMemoryInput(pending, "durable:4");
  forgetHomeMemory(value.userId, value.agentId);
  assert.deepEqual(
    commitHomeCapture(
      value.userId,
      value.agentId,
      settings.generation,
      [pending],
      [candidate(pending)],
    ),
    [],
  );
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 0);
  assert.throws(() => parseHomeCaptureResult('{"candidates":[{"content":"made up"}]}'));
});

test("automatic corrections replace one scoped fact and source edits retire only affected automatic notes", () => {
  const value = fixture();
  const settings = setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const first = source(value, "For Carmel, I prefer minimal UI labels.");
  recordHomeMemoryInput(first, "durable:1");
  const [note] = commitHomeCapture(
    value.userId,
    value.agentId,
    settings.generation,
    [first],
    [candidate(first)],
  );
  assert.ok(note);
  const next = source(value, "For Carmel, I now prefer descriptive labels.");
  recordHomeMemoryInput(next, "durable:2");
  const updated = commitHomeCapture(
    value.userId,
    value.agentId,
    settings.generation,
    [next],
    [
      candidate(next, {
        content: "The user prefers descriptive labels for Carmel.",
        replacesId: note.id,
        expectedRevision: note.revision,
      }),
    ],
  );
  assert.equal(updated[0]?.revision, 2);
  assert.equal(activeHomeMemories(value.userId, value.agentId).length, 1);
  const manual = saveHomeMemory(value.userId, value.agentId, {
    content: "An explicit independent fact",
  });
  invalidateHomeMemorySources(value.sessionId, ["durable:1"]);
  assert.equal(activeHomeMemories(value.userId, value.agentId).length, 2);
  invalidateHomeMemorySources(value.sessionId, ["durable:2"]);
  assert.deepEqual(
    activeHomeMemories(value.userId, value.agentId).map((row) => row.id),
    [manual.id],
  );
});

test("idle capture uses a tool-free model call once and stores evidence without changing Home execution", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For Carmel, I prefer minimal UI labels.");
  recordHomeMemoryInput(event, "durable:50");
  const notice = source(value, "A background task completed.", "background");
  db.update(homeEvents)
    .set({ createdAt: Date.now() + 300000 })
    .where(eq(homeEvents.id, notice.id))
    .run();
  const models = fauxHarnessModels();
  models.faux.setResponses([
    fauxAssistantMessage(JSON.stringify({ candidates: [candidate(event)] })),
  ]);
  let calls = 0;
  const resolve = async () => {
    calls++;
    return {
      ok: true as const,
      value: {
        model: models.model,
        modelRuntime: models.models,
        modelRef: db.select().from(modelRefs).where(eq(modelRefs.id, value.modelRefId)).get()!,
      },
    };
  };
  await captureHomeMemories(Date.now(), resolve);
  assert.equal(calls, 0);
  await captureHomeMemories(Date.now() + 180000, resolve);
  assert.equal(calls, 1);
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 1);
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).calls.length, 1);
  await captureHomeMemories(Date.now() + 210000, resolve);
  assert.equal(calls, 1);
  assert.equal(
    db.select().from(homeEvents).where(eq(homeEvents.id, event.id)).get()?.status,
    "done",
  );
});

test("a failed capture gets one delayed retry and never creates a Home message or memory", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For this project, I prefer SQLite for metadata.");
  recordHomeMemoryInput(event, "durable:51");
  let calls = 0;
  const resolve = async () => {
    calls++;
    throw new Error("synthetic failure");
  };
  const at = Date.now() + 180000;
  await captureHomeMemories(at, resolve);
  await captureHomeMemories(at + 1, resolve);
  assert.equal(calls, 1);
  await captureHomeMemories(at + 60001, resolve);
  await captureHomeMemories(at + 120001, resolve);
  assert.equal(calls, 2);
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 0);
  assert.match(readHomeMemoryOverview(value.userId, value.agentId).error!, /could not finish/);
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).calls.length, 2);
});

test("Home memory tool results stay bounded when many long notes match", async () => {
  const value = fixture();
  const event = source(value, "What do you remember about Saffron?");
  for (let index = 0; index < 20; index++)
    saveHomeMemory(value.userId, value.agentId, {
      content: `Saffron choice ${index}: ${"specific project detail ".repeat(75)}`,
    });
  const models = fauxHarnessModels();
  models.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("home_memory_search", { query: "Saffron" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Here are the relevant choices."),
  ]);
  const harness = await openTestHarness(value.sessionId, {
    ...models,
    tools: createHomeMemoryTools(value.userId, value.agentId, value.sessionId, event.id),
  });
  try {
    await harness.prompt(event.prompt.text);
    const result = (await harness.branch()).find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    assert.ok(result?.type === "message" && result.message.role === "toolResult");
    const text = result.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const output = JSON.parse(text);
    assert.equal(output.truncated, true);
    assert.ok(output.memories.length > 0 && output.memories.length <= 8);
    assert.ok(estimateTextTokens(text) < 2200);
  } finally {
    await harness.close();
  }
});
