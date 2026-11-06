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
  placeAutomaticHomeMemory,
} from "./home-memory.ts";
import {
  buildHomeMemorySections,
  createHomeMemoryTools,
  humanHomeMemoryEvent,
} from "../runtime/home-memory-tools.ts";
import {
  recordHomeMemoryInput,
  commitHomeCapture,
  parseHomeCaptureResult,
  parseHomeCapturePayload,
  captureHomeMemories,
  HOME_CAPTURE_TOOL,
  type HomeMemoryCandidate,
} from "./home-memory-capture.ts";
import {
  homeMemoryNotebookFits,
  homeMemoryNotebookSize,
  renderHomeMemoryNotes,
} from "./home-memory-notebook.ts";

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
    placement: "topic",
    aliases: [],
    confidence: 0.9,
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

test("learned core reaches the model before answering unrelated requests without a tool call", async () => {
  const value = fixture();
  const settings = setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "I am vegetarian and always avoid meat and fish.");
  recordHomeMemoryInput(event, "durable:1");
  const [note] = commitHomeCapture(
    value.userId,
    value.agentId,
    settings.generation,
    [event],
    [
      candidate(event, {
        content: "The user is vegetarian and avoids meat & fish.",
        scope: "Food",
        placement: "core",
        slot: "diet/vegetarian",
      }),
    ],
  );
  assert.equal(note?.placement, "core");
  assert.equal(note?.pinned, false);
  const sections = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "What should I make tonight?",
    100000,
  );
  assert.equal(JSON.parse(sections.home_memory_core!)[0].content, note!.content);
  assert.equal(sections.home_memory_recall, undefined);
  saveHomeMemory(value.userId, value.agentId, { content: "Saffron uses SQLite" });
  const other = buildHomeMemorySections(value.userId, value.agentId, "Saffron deployment", 100000);
  assert.equal(other.home_memory_core, sections.home_memory_core);
  assert.match(other.home_memory_recall!, /SQLite/);
  const models = fauxHarnessModels();
  models.faux.setResponses([
    (context) => {
      assert.match(JSON.stringify(context), /vegetarian/);
      assert.doesNotMatch(JSON.stringify(context), /Saffron uses SQLite/);
      return fauxAssistantMessage("Try a lentil curry.");
    },
  ]);
  const harness = await openTestHarness(value.sessionId, { ...models, promptSections: sections });
  try {
    await harness.prompt("What should I make tonight?");
    assert.equal(
      (await harness.branch()).filter(
        (entry) => entry.type === "message" && entry.message.role === "toolResult",
      ).length,
      0,
    );
  } finally {
    await harness.close();
  }
  await resetHome(value.userId, value.agentId);
  assert.equal(
    buildHomeMemorySections(value.userId, value.agentId, "Unrelated", 100000).home_memory_core,
    sections.home_memory_core,
  );
});

test("core uses a 200-line / 24,000-byte notebook with pins taking priority", () => {
  const value = fixture();
  const provenance = {
    origin: "automatic" as const,
    eventId: source(value, "A lasting preference.").id,
    entryId: null,
    quote: "A lasting preference.",
  };
  const notes = Array.from({ length: 25 }, (_, index) =>
    saveHomeMemory(
      value.userId,
      value.agentId,
      { content: `${index}: ${"lasting preference ".repeat(90)}`, placement: "core" },
      provenance,
    ),
  );
  const before = readHomeMemoryOverview(value.userId, value.agentId);
  assert.ok(before.coreIds.length > 5);
  assert.ok(before.coreBytes <= 24000 && before.coreLines <= 200);
  assert.equal(notes[0]!.placement, "core");
  const overflow = notes.find((note) => note.placement === "topic")!;
  assert.ok(overflow);
  assert.throws(
    () =>
      editHomeMemory(value.userId, value.agentId, overflow.id, {
        expectedRevision: 1,
        placement: "core",
      }),
    /200 lines/,
  );
  editHomeMemory(value.userId, value.agentId, overflow.id, { expectedRevision: 1, pinned: true });
  const overview = readHomeMemoryOverview(value.userId, value.agentId);
  assert.ok(
    overview.coreBytes <= overview.coreMaxBytes && overview.coreLines <= overview.coreMaxLines,
  );
  assert.ok(overview.coreIds.includes(overflow.id));
  assert.equal(overview.total, notes.length);
  const demoted = overview.memories.find(
    (note) => before.coreIds.includes(note.id) && note.placement === "topic",
  )!;
  assert.ok(demoted);
  assert.equal(homeMemoryHistory(value.userId, value.agentId, demoted.id)[0]?.placement, "topic");
});

test("capture curates existing automatic notes while preserving evidence and user choices", () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const provenance = {
    origin: "automatic" as const,
    eventId: source(value, "I always prefer concise replies.").id,
    entryId: "durable:1",
    quote: "I always prefer concise replies.",
  };
  const stable = saveHomeMemory(
    value.userId,
    value.agentId,
    { content: "Prefer concise replies." },
    provenance,
  );
  const project = saveHomeMemory(
    value.userId,
    value.agentId,
    { content: "Saffron uses SQLite.", placement: "core" },
    provenance,
  );
  const manual = saveHomeMemory(value.userId, value.agentId, { content: "A user-managed note." });
  const event = source(value, "Thanks, that helps.");
  recordHomeMemoryInput(event, "durable:2");
  const generation = readHomeMemorySettings(value.userId, value.agentId).generation;
  const saved = commitHomeCapture(
    value.userId,
    value.agentId,
    generation,
    [event],
    [],
    Date.now(),
    [
      {
        id: stable.id,
        expectedRevision: 1,
        placement: "core",
        reason: "Lasting reply style applies across topics.",
      },
      {
        id: project.id,
        expectedRevision: 1,
        placement: "topic",
        scope: "Saffron",
        aliases: ["deployment"],
        reason: "This is a specific project decision.",
      },
      {
        id: manual.id,
        expectedRevision: 1,
        placement: "core",
        reason: "A user choice must remain protected.",
      },
    ],
  );
  assert.equal(saved.length, 2);
  assert.deepEqual(readHomeMemoryOverview(value.userId, value.agentId).coreIds, [stable.id]);
  assert.equal(searchHomeMemories(value.userId, value.agentId, "deployment")[0]?.id, project.id);
  const promoted = saved.find((note) => note.id === stable.id)!;
  assert.equal(promoted.sourceQuote, provenance.quote);
  assert.equal(promoted.sourceEntryId, provenance.entryId);
  assert.equal(
    placeAutomaticHomeMemory(value.userId, value.agentId, stable.id, 1, "topic"),
    undefined,
  );
  assert.equal(
    placeAutomaticHomeMemory(value.userId, value.agentId, stable.id, 2, "core"),
    undefined,
  );
  editHomeMemory(value.userId, value.agentId, stable.id, {
    expectedRevision: 2,
    placement: "topic",
  });
  assert.equal(
    placeAutomaticHomeMemory(value.userId, value.agentId, stable.id, 3, "core"),
    undefined,
  );
  assert.deepEqual(readHomeMemoryOverview(value.userId, value.agentId).coreIds, []);
  const legacy = homeMemoryHistory(value.userId, value.agentId, manual.id)[0]!;
  const { placement: _placement, ...snapshot } = legacy;
  db.update(homeMemoryRevisions)
    .set({ snapshot })
    .where(eq(homeMemoryRevisions.memoryId, manual.id))
    .run();
  assert.equal(restoreHomeMemory(value.userId, value.agentId, manual.id, 1, 1).placement, "topic");
});

test("Home memory remains private between users of the same shared agent, including API and search", async () => {
  const value = fixture();
  db.update(agents).set({ shared: true }).where(eq(agents.id, value.agentId)).run();
  const other = createUser();
  ensureHome(other, value.agentId);
  const note = saveHomeMemory(value.userId, value.agentId, {
    content: "Private Saffron deployment choice",
    placement: "core",
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
  assert.deepEqual(
    buildHomeMemorySections(value.userId, value.agentId, "Saffron deployment", 100000),
    {
      home_memory: undefined,
      home_memory_core: undefined,
      home_memory_topics: undefined,
      home_memory_recall: undefined,
    },
  );
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 1);
});

test("pinning preserves note fields and topical recall stays bounded", () => {
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
  const context = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "Saffron deployment",
    100000,
  );
  const recalled = [
    ...JSON.parse(context.home_memory_core ?? "[]"),
    ...JSON.parse(context.home_memory_recall ?? "[]"),
  ];
  assert.ok(recalled.length <= 5);
  assert.ok(estimateTextTokens(JSON.stringify(recalled)) < 1500);
  assert.equal(
    JSON.parse(
      buildHomeMemorySections(value.userId, value.agentId, "unrelated penguins", 100000)
        .home_memory_core!,
    ).length,
    1,
  );
  const large = saveHomeMemory(value.userId, value.agentId, {
    content: "long information ".repeat(110),
  });
  assert.equal(
    editHomeMemory(value.userId, value.agentId, large.id, { expectedRevision: 1, pinned: true })
      .pinned,
    true,
  );
});

test("notebook limits count rendered lines and UTF-8 bytes, including non-Latin notes", () => {
  const short = { id: "n", revision: 1, scope: "", content: "A fact." };
  assert.equal(homeMemoryNotebookSize(Array(198).fill(short)).lines, 200);
  assert.equal(homeMemoryNotebookFits(Array(198).fill(short)), true);
  assert.equal(homeMemoryNotebookFits(Array(199).fill(short)), false);
  const unicode = Array(8).fill({ ...short, content: "日常偏好".repeat(300) });
  assert.ok(renderHomeMemoryNotes(unicode).length < 24000);
  assert.ok(homeMemoryNotebookSize(unicode).bytes > 24000);
  assert.equal(homeMemoryNotebookFits(unicode), false);
});

test("topics are indexed by scope and aliases and recalled before the model needs to search", async () => {
  const value = fixture();
  const note = saveHomeMemory(value.userId, value.agentId, {
    scope: "Food",
    content: "The user likes mushrooms and tofu.",
    aliases: ["dinner", "restaurants", "cuisine"],
  });
  const unrelated = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "What is the weather?",
    100000,
  );
  assert.match(unrelated.home_memory_topics!, /Food/);
  assert.match(unrelated.home_memory_topics!, /dinner/);
  assert.equal(unrelated.home_memory_recall, undefined);
  assert.doesNotMatch(unrelated.home_memory_topics!, /mushrooms/);
  const recalled = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "Any dinner ideas?",
    100000,
  );
  assert.match(recalled.home_memory_recall!, /mushrooms and tofu/);
  assert.equal(searchHomeMemories(value.userId, value.agentId, "dinner")[0]?.id, note.id);
  const plural = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "Which restaurant would you pick?",
    100000,
  );
  assert.match(plural.home_memory_recall!, /mushrooms/);
  const other = createUser();
  db.update(agents).set({ shared: true }).where(eq(agents.id, value.agentId)).run();
  ensureHome(other, value.agentId);
  assert.equal(
    buildHomeMemorySections(other, value.agentId, "Any dinner ideas?", 100000).home_memory_topics,
    undefined,
  );
  assert.deepEqual(searchHomeMemories(other, value.agentId, "dinner"), []);
  const updated = editHomeMemory(value.userId, value.agentId, note.id, {
    expectedRevision: 1,
    aliases: ["supper"],
  });
  assert.deepEqual(searchHomeMemories(value.userId, value.agentId, "dinner"), []);
  assert.equal(searchHomeMemories(value.userId, value.agentId, "supper")[0]?.id, note.id);
  forgetHomeMemory(value.userId, value.agentId, note.id, updated.revision);
  assert.equal(
    buildHomeMemorySections(value.userId, value.agentId, "Any supper ideas?", 100000)
      .home_memory_recall,
    undefined,
  );
});

test("the topic index and automatic passages have their own limits beside the core notebook", () => {
  const value = fixture();
  for (let i = 0; i < 45; i++)
    saveHomeMemory(value.userId, value.agentId, {
      scope: `Subject ${String(i).padStart(2, "0")}`,
      aliases: ["shared-topic", `<${i}>`],
      content: `${i}: ${"topic detail ".repeat(150)}`,
    });
  const sections = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "Tell me about shared-topic",
    100000,
  );
  assert.ok(sections.home_memory_topics!.length <= 2000);
  const index = sections.home_memory_topics!.split("\n").map((line) => JSON.parse(line));
  assert.ok(index.filter((topic) => topic.scope !== undefined).length <= 40);
  assert.ok(index.at(-1).omittedTopics > 0);
  assert.ok(sections.home_memory_recall!.length <= 6000);
  const notes = JSON.parse(sections.home_memory_recall!);
  assert.equal(new Set(notes.map((note: { scope: string }) => note.scope)).size, 4);
  assert.ok(notes.every((note: { content: string }) => note.content.length <= 600));
});

test("dated capture expires automatically and rejects uncertain or already expired facts", () => {
  const value = fixture();
  const settings = setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "My exams are confirmed for next week.");
  recordHomeMemoryInput(event, "durable:1");
  const until = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const [note] = commitHomeCapture(
    value.userId,
    value.agentId,
    settings.generation,
    [event],
    [
      candidate(event, {
        content: "The user has exams next week.",
        scope: "Exams",
        aliases: ["revision", "study"],
        until,
      }),
    ],
  );
  assert.equal(note?.expiresAt, Date.parse(`${until}T00:00:00Z`) + 86400000);
  assert.match(
    buildHomeMemorySections(value.userId, value.agentId, "Help me with study", 100000)
      .home_memory_recall!,
    /exams/,
  );
  const next = source(value, "I might prefer concise replies.");
  recordHomeMemoryInput(next, "durable:2");
  assert.deepEqual(
    commitHomeCapture(
      value.userId,
      value.agentId,
      settings.generation,
      [next],
      [candidate(next, { confidence: 0.5 }), candidate(next, { until: "2020-01-01" })],
    ),
    [],
  );
  assert.throws(() =>
    parseHomeCaptureResult(
      JSON.stringify({ candidates: [candidate(next, { until: "2026-02-30" })] }),
    ),
  );
  const expiredNote = editHomeMemory(value.userId, value.agentId, note!.id, {
    expectedRevision: 1,
    expiresAt: Date.now() - 1,
  });
  assert.equal(expiredNote.origin, "manual");
  const expired = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "Help me with study",
    100000,
  );
  assert.equal(expired.home_memory_topics, undefined);
  assert.equal(expired.home_memory_recall, undefined);
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
  assert.deepEqual(readHomeMemoryOverview(value.userId, value.agentId).coreIds, []);
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
    placement: "core",
    expiresAt: Date.now() - 1,
  });
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 1);
  assert.deepEqual(searchHomeMemories(value.userId, value.agentId, "Saffron"), []);
  assert.deepEqual(readHomeMemoryOverview(value.userId, value.agentId).coreIds, []);
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
    buildHomeMemorySections(value.userId, value.agentId, "Carmel UI", 100000).home_memory_recall!,
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
    [candidate(first, { placement: "core" })],
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
        placement: "core",
        replacesId: note.id,
        expectedRevision: note.revision,
      }),
    ],
  );
  assert.equal(updated[0]?.revision, 2);
  const context = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "unrelated",
    100000,
  ).home_memory_core!;
  assert.match(context, /descriptive labels/);
  assert.doesNotMatch(context, /minimal labels/);
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

test("idle capture uses one isolated model call and stores evidence without changing Home execution", async () => {
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

test("loosely shaped model output keeps every usable candidate and drops the rest", () => {
  const value = fixture();
  const event = source(value, "My homelab runs on Proxmox. I prefer concise replies.");
  const text = [
    "Here is the JSON:",
    "```JSON",
    JSON.stringify({
      candidates: [
        {
          ...candidate(event, { slot: "homelab/host" }),
          until: null,
          replacesId: null,
          expectedRevision: null,
          reason: "a key the prompt never asked for",
        },
        { ...candidate(event, { slot: "style/replies" }), confidence: "0.8", until: "" },
        { content: "made up", kind: "fact" },
      ],
      curation: [
        { id: "memory_1", expectedRevision: 1, placement: "core", reason: "短" },
        { id: "memory_2" },
      ],
      notes: "extra top-level keys are ignored",
    }),
    "```",
    "Let me know if you need more.",
  ].join("\n");
  const result = parseHomeCaptureResult(text);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]!.until, undefined);
  assert.equal(result.candidates[0]!.replacesId, undefined);
  assert.equal(result.candidates[1]!.confidence, 0.8);
  assert.equal(result.candidates[1]!.until, undefined);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!, /kind|placement|confidence/);
  assert.equal(result.curation.length, 1);
  assert.equal(result.curation[0]!.reason, "短");
});

test("idle capture saves the usable candidate and records what the model returned", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For Homelab I run Proxmox on a single PC.");
  recordHomeMemoryInput(event, "durable:60");
  const models = fauxHarnessModels();
  models.faux.setResponses([
    fauxAssistantMessage(
      `\`\`\`json\n${JSON.stringify({
        candidates: [candidate(event, { slot: "homelab/proxmox" }), { content: "broken" }],
      })}\n\`\`\``,
    ),
  ]);
  const resolve = async () => ({
    ok: true as const,
    value: {
      model: models.model,
      modelRuntime: models.models,
      modelRef: db.select().from(modelRefs).where(eq(modelRefs.id, value.modelRefId)).get()!,
    },
  });
  await captureHomeMemories(Date.now() + 180000, resolve);
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 1);
  const settings = readHomeMemorySettings(value.userId, value.agentId);
  assert.equal(settings.error, null);
  assert.equal(settings.lastCapture?.stopReason, "stop");
  assert.equal(settings.lastCapture?.candidates, 1);
  assert.equal(settings.lastCapture?.saved, 1);
  assert.equal(settings.lastCapture?.rejected.length, 1);
  assert.equal(
    settings.lastCapture?.model,
    db.select().from(modelRefs).where(eq(modelRefs.id, value.modelRefId)).get()!.modelId,
  );
  assert.equal(
    db.select().from(homeMemoryCaptures).where(eq(homeMemoryCaptures.eventId, event.id)).get()
      ?.status,
    "done",
  );
});

test("capture reads the tool call instead of parsing reply text", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For Homelab I run Proxmox on a single fanless PC.");
  recordHomeMemoryInput(event, "durable:62");
  const models = fauxHarnessModels();
  models.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(HOME_CAPTURE_TOOL, {
          candidates: [
            candidate(event, { slot: "homelab/host" }),
            { content: "made up", kind: "fact" },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  const resolve = async () => ({
    ok: true as const,
    value: {
      model: models.model,
      modelRuntime: models.models,
      modelRef: db.select().from(modelRefs).where(eq(modelRefs.id, value.modelRefId)).get()!,
    },
  });
  await captureHomeMemories(Date.now() + 180000, resolve);
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 1);
  const settings = readHomeMemorySettings(value.userId, value.agentId);
  assert.equal(settings.lastCapture?.route, "tool");
  assert.equal(settings.lastCapture?.stopReason, "toolUse");
  assert.equal(settings.lastCapture?.candidates, 1);
  assert.equal(settings.lastCapture?.saved, 1);
  assert.equal(settings.lastCapture?.rejected.length, 1);
  assert.equal(settings.error, null);
});

test("tool arguments handed back as JSON text are still read", () => {
  const value = fixture();
  const event = source(value, "For Homelab I run Proxmox.");
  const result = parseHomeCapturePayload(
    JSON.stringify({ candidates: [candidate(event, { slot: "homelab/host" })] }),
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.slot, "homelab/host");
});

test("a truncated answer retries and an unusable one names the rejected field", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For this project, I prefer SQLite for metadata.");
  recordHomeMemoryInput(event, "durable:61");
  const models = fauxHarnessModels();
  models.faux.setResponses([
    fauxAssistantMessage('{"candidates":[{"content":"partial', { stopReason: "length" }),
    fauxAssistantMessage(JSON.stringify({ candidates: [{ content: "made up", kind: "fact" }] })),
  ]);
  const resolve = async () => ({
    ok: true as const,
    value: {
      model: models.model,
      modelRuntime: models.models,
      modelRef: db.select().from(modelRefs).where(eq(modelRefs.id, value.modelRefId)).get()!,
    },
  });
  const at = Date.now() + 180000;
  await captureHomeMemories(at, resolve);
  assert.match(readHomeMemoryOverview(value.userId, value.agentId).error!, /cut off/);
  assert.equal(
    db.select().from(homeMemoryCaptures).where(eq(homeMemoryCaptures.eventId, event.id)).get()
      ?.status,
    "pending",
  );
  await captureHomeMemories(at + 60001, resolve);
  const error = readHomeMemoryOverview(value.userId, value.agentId).error!;
  assert.match(error, /Nothing was saved/);
  assert.match(error, /kind|placement|confidence|slot/, error);
  assert.equal(
    db.select().from(homeMemoryCaptures).where(eq(homeMemoryCaptures.eventId, event.id)).get()
      ?.status,
    "error",
  );
  assert.equal(readHomeMemoryOverview(value.userId, value.agentId).total, 0);
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
