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
  homeMemories,
  homeMemoryCaptures,
  homeMemoryRevisions,
  modelRefs,
  sessions,
  users,
} from "../db/schema.ts";
import { createSession, createUser } from "../test-support.ts";
import { ensureHome, resetHome } from "../services/agent-homes.ts";
import { createHomeMemoryRoutes } from "./routes.ts";
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
  isHomeMemoryForgotten,
  factIdentity,
} from "./service.ts";
import {
  tidyHomeMemories,
  dreamHomeMemories,
  checkDreamFacts,
  ORGANIZE_MARKER,
  TIDY_MARKER,
  DREAM_MARKER,
} from "./upkeep.ts";
import { buildHomeMemorySections, createHomeMemoryTools, humanHomeMemoryEvent } from "./tools.ts";
import {
  recordHomeMemoryInput,
  commitHomeCapture,
  parseHomeCaptureResult,
  parseHomeCapturePayload,
  captureHomeMemories,
  HOME_CAPTURE_TOOL,
  type HomeMemoryCandidate,
} from "./capture.ts";
import {
  homeMemoryNotebookFits,
  homeMemoryNotebookSize,
  renderHomeMemoryNotes,
} from "./notebook.ts";

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
  assert.match(
    sections.home_memory_core!,
    /\[Food\] The user is vegetarian and avoids meat & fish\./,
  );
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
  editHomeMemory(value.userId, value.agentId, overflow.id, {
    expectedRevision: 1,
    placement: "core",
  });
  const afterCorePromote = readHomeMemoryOverview(value.userId, value.agentId);
  assert.ok(afterCorePromote.coreIds.includes(overflow.id));
  assert.ok(
    afterCorePromote.coreBytes <= afterCorePromote.coreMaxBytes &&
      afterCorePromote.coreLines <= afterCorePromote.coreMaxLines,
  );
  editHomeMemory(value.userId, value.agentId, overflow.id, { expectedRevision: 2, pinned: true });
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

test("automatic mode is default; manual mode skips background capture; human Home provenance alone enables tools; Off removes recall and tools", () => {
  const value = fixture();
  const human = source(value, "Remember my Saffron deployment choice");
  const background = source(value, "Remember my Saffron deployment choice", "background");
  saveHomeMemory(value.userId, value.agentId, { content: "Saffron deployment choice" });
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).mode, "automatic");
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).mode, "manual");
  recordHomeMemoryInput(human, "durable:1");
  assert.equal(
    db.select().from(homeMemoryCaptures).where(eq(homeMemoryCaptures.eventId, human.id)).get(),
    undefined,
  );
  assert.equal(
    createHomeMemoryTools(value.userId, value.agentId, value.sessionId, human.id).length,
    5,
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
  const recalledLines = [
    ...(context.home_memory_core?.split("\n") ?? []),
    ...(context.home_memory_recall?.split("\n") ?? []),
  ];
  assert.ok(recalledLines.length <= 5);
  assert.ok(estimateTextTokens(recalledLines.join("\n")) < 1500);
  assert.equal(
    buildHomeMemorySections(
      value.userId,
      value.agentId,
      "unrelated penguins",
      100000,
    ).home_memory_core!.split("\n").length,
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
  assert.equal(homeMemoryNotebookSize(Array(200).fill(short)).lines, 200);
  assert.equal(homeMemoryNotebookFits(Array(200).fill(short)), true);
  assert.equal(homeMemoryNotebookFits(Array(201).fill(short)), false);
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
  await forgetHomeMemory(value.userId, value.agentId, note.id, updated.revision);
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
  const indexLines = sections.home_memory_topics!.split("\n");
  assert.ok(indexLines.filter((line) => !line.includes("more topic")).length <= 40);
  assert.match(indexLines.at(-1)!, /more topics/);
  assert.ok(sections.home_memory_recall!.length <= 6000);
  const recallLines = sections.home_memory_recall!.split("\n");
  assert.equal(recallLines.length, 4);
  assert.ok(recallLines.every((line) => line.length <= 700));
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

test("revision-safe edits and forgetting purge search and all revision text", async () => {
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
  await assert.rejects(forgetHomeMemory(value.userId, value.agentId, note.id, 1), /changed/);
  const restored = restoreHomeMemory(value.userId, value.agentId, note.id, 1, edited.revision);
  assert.equal(restored.content, note.content);
  await forgetHomeMemory(value.userId, value.agentId, note.id, restored.revision);
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

test("capture rejects forged evidence, questions, background notices and results pending before forget", async () => {
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
  await forgetHomeMemory(value.userId, value.agentId);
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

function systemPromptOf(context: { messages: { role: string; content: unknown }[] }) {
  const system = context.messages.find((message) => message.role === "system");
  return typeof system?.content === "string"
    ? system.content
    : JSON.stringify(system?.content ?? "");
}

test("forgetting blocks later automatic relearning and stores no forgotten note text", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const first = source(value, "For Carmel, I prefer minimal UI labels.");
  recordHomeMemoryInput(first, "forget:first");
  const [note] = commitHomeCapture(
    value.userId,
    value.agentId,
    readHomeMemorySettings(value.userId, value.agentId).generation,
    [first],
    [candidate(first)],
  );
  await forgetHomeMemory(value.userId, value.agentId, note!.id, note!.revision);
  const settings = readHomeMemorySettings(value.userId, value.agentId);
  assert.equal(settings.forgotten.length, 1);
  assert.equal(
    isHomeMemoryForgotten(value.userId, value.agentId, {
      content: "Use more descriptive labels.",
      scope: "Carmel UI",
      slot: "carmel/ui/labels",
    }),
    true,
  );
  assert.equal(
    isHomeMemoryForgotten(value.userId, value.agentId, {
      content: "The user prefers dark mode in Carmel.",
      scope: "Carmel UI",
      slot: "carmel/ui/theme",
    }),
    false,
  );
  assert.doesNotMatch(JSON.stringify(settings.forgotten), /minimal|labels|Carmel|carmel\/ui/);
  assert.deepEqual(searchHomeMemories(value.userId, value.agentId, "minimal labels"), []);
  for (const slot of ["carmel/ui/labels", "carmel/labels/style"]) {
    const later = source(value, "My preference for Carmel interfaces is minimal labels.");
    recordHomeMemoryInput(later, `forget:${slot}`);
    assert.deepEqual(
      commitHomeCapture(
        value.userId,
        value.agentId,
        settings.generation,
        [later],
        [
          candidate(later, {
            content: "For Carmel interfaces, minimal labels are preferred.",
            slot,
          }),
        ],
      ),
      [],
    );
  }
  setHomeMemorySettings(value.userId, value.agentId, { mode: "off" });
  resetHome(value.userId, value.agentId);
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  assert.equal(
    isHomeMemoryForgotten(value.userId, value.agentId, {
      content: note!.content,
      scope: note!.scope,
    }),
    true,
  );
  const other = createUser();
  db.update(agents).set({ shared: true }).where(eq(agents.id, value.agentId)).run();
  ensureHome(other, value.agentId);
  assert.equal(
    isHomeMemoryForgotten(other, value.agentId, {
      content: note!.content,
      scope: note!.scope,
      slot: "carmel/ui/labels",
    }),
    false,
  );
});

test("deleting a saved copy allows later learning and invalid forget requests preserve the note", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const note = saveHomeMemory(value.userId, value.agentId, {
    content: "The user prefers minimal labels in Carmel interfaces.",
    scope: "Carmel UI",
  });
  const app = appFor(value.userId);
  const path = `/agents/${value.agentId}/home/memory/${note.id}`;
  assert.equal(
    (await app.request(`${path}?revision=1&preventLearning=invalid`, { method: "DELETE" })).status,
    400,
  );
  assert.equal(
    (await app.request(`${path}?revision=2&preventLearning=false`, { method: "DELETE" })).status,
    409,
  );
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).forgotten.length, 0);
  assert.equal(
    (await app.request(`${path}?revision=1&preventLearning=false`, { method: "DELETE" })).status,
    200,
  );
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).forgotten.length, 0);
  const later = source(value, "For Carmel, I prefer minimal UI labels.");
  recordHomeMemoryInput(later, "delete:later");
  const saved = commitHomeCapture(
    value.userId,
    value.agentId,
    readHomeMemorySettings(value.userId, value.agentId).generation,
    [later],
    [candidate(later)],
  );
  assert.equal(saved.length, 1);
  const tools = createHomeMemoryTools(value.userId, value.agentId, value.sessionId, later.id);
  await tools
    .find((tool) => tool.name === "memory_forget")!
    .execute(
      { id: saved[0]!.id, expectedRevision: saved[0]!.revision, preventLearning: false },
      undefined as never,
      undefined as never,
    );
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).forgotten.length, 0);
  const again = saveHomeMemory(value.userId, value.agentId, {
    content: note.content,
    scope: note.scope,
  });
  assert.equal(
    (
      await app.request(`/agents/${value.agentId}/home/memory/${again.id}?revision=1`, {
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(isHomeMemoryForgotten(value.userId, value.agentId, note), true);
});

test("an explicit request to remember again clears only matching learning restrictions", async () => {
  const value = fixture();
  const labels = saveHomeMemory(value.userId, value.agentId, {
    content: "The user prefers minimal labels in Carmel interfaces.",
    scope: "Carmel UI",
  });
  const food = saveHomeMemory(value.userId, value.agentId, {
    content: "The user avoids shellfish at restaurants.",
    scope: "Food",
  });
  await forgetHomeMemory(value.userId, value.agentId);
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).forgotten.length, 2);
  saveHomeMemory(value.userId, value.agentId, {
    content: "Use SQLite for project metadata.",
    scope: "Carmel",
  });
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).forgotten.length, 2);
  assert.throws(() =>
    saveHomeMemory(value.userId, value.agentId, { content: "x".repeat(20001), scope: "Carmel UI" }),
  );
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).forgotten.length, 2);
  const event = source(value, "Remember again: I prefer minimal labels for Carmel interfaces.");
  saveHomeMemory(
    value.userId,
    value.agentId,
    { content: "For Carmel interfaces, minimal labels are preferred.", scope: "Carmel UI" },
    { origin: "explicit", eventId: event.id, entryId: null, quote: event.prompt.text },
  );
  assert.equal(isHomeMemoryForgotten(value.userId, value.agentId, labels), false);
  assert.equal(isHomeMemoryForgotten(value.userId, value.agentId, food), true);
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).forgotten.length, 1);
});

test("correction context keeps the older fact visible among long notes and across message batches", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const first = source(value, "我的 homelab 主力机是 i7-12900 CPU，16GB 内存。");
  recordHomeMemoryInput(first, "long-correction:first");
  const [note] = commitHomeCapture(
    value.userId,
    value.agentId,
    readHomeMemorySettings(value.userId, value.agentId).generation,
    [first],
    [
      candidate(first, {
        content: "Homelab 主力机：i7-12900 CPU，16GB 内存。",
        scope: "homelab 硬件",
        slot: "homelab/hardware-main-machine",
      }),
    ],
  );
  const protectedNotes = [];
  for (let index = 0; index < 9; index++)
    protectedNotes.push(
      saveHomeMemory(value.userId, value.agentId, {
        title: `Project reference ${index}`,
        scope: `Project ${index}`,
        placement: index < 2 ? "core" : "topic",
        content: `${index}: ` + "A settled project reference. ".repeat(index < 2 ? 350 : 650),
      }),
    );
  const correction = source(value, "啊对，应该是i7-12700。");
  const other = source(value, "Thanks, that completes the task.");
  recordHomeMemoryInput(correction, "long-correction:next");
  recordHomeMemoryInput(other, "long-correction:other");
  const models = fauxHarnessModels();
  let seen = "";
  models.faux.setResponses([
    (context) => {
      seen = systemPromptOf(context);
      return fauxAssistantMessage(
        [
          fauxToolCall(HOME_CAPTURE_TOOL, {
            candidates: [
              candidate(correction, {
                content: "Homelab 主力机：i7-12700 CPU，16GB 内存。",
                scope: "homelab 硬件",
                slot: "homelab/hardware-main-machine",
                evidence: "应该是i7-12700",
                replacesId: note!.id,
                expectedRevision: note!.revision,
              }),
            ],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
  ]);
  await captureHomeMemories(Date.now() + 180000, async () => ({
    ok: true as const,
    value: {
      model: models.model,
      modelRuntime: models.models,
      modelRef: db.select().from(modelRefs).where(eq(modelRefs.id, value.modelRefId)).get()!,
    },
  }));
  const context = JSON.parse(seen.slice(seen.lastIndexOf("\n\n") + 2));
  assert.equal(context.inventory.length, 10);
  assert.ok(context.inventory.some((item: { id: string }) => item.id === note!.id));
  assert.ok(
    context.existing.some(
      (item: { id: string; content: string }) =>
        item.id === note!.id && item.content.includes("i7-12900"),
    ),
  );
  assert.ok(
    JSON.stringify({
      inventory: context.inventory,
      existing: context.existing,
      omitted: context.omitted,
    }).length <= 24000,
  );
  assert.ok(context.existing.every((item: { content: string }) => item.content.length <= 1000));
  const updated = activeHomeMemories(value.userId, value.agentId).find(
    (item) => item.id === note!.id,
  )!;
  assert.equal(updated.revision, 2);
  assert.match(updated.content, /i7-12700.*16GB/);
  for (const original of protectedNotes)
    assert.equal(
      activeHomeMemories(value.userId, value.agentId).find((item) => item.id === original.id)
        ?.content,
      original.content,
    );
  assert.equal(activeHomeMemories(value.userId, value.agentId).length, 10);
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
});

test("a short batch sees every note, so a reworded correction replaces it", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const original = source(value, "我的 homelab 主力机是 i7-12900 CPU，16GB 内存。");
  recordHomeMemoryInput(original, "durable:70");
  const [note] = commitHomeCapture(
    value.userId,
    value.agentId,
    readHomeMemorySettings(value.userId, value.agentId).generation,
    [original],
    [
      candidate(original, {
        content: "Homelab 主力机：i7-12900 CPU，16GB 内存。",
        scope: "homelab 硬件",
        slot: "homelab/hardware-main-machine",
        evidence: "我的 homelab 主力机是 i7-12900 CPU，16GB 内存。",
      }),
    ],
  );
  assert.ok(note);
  // The correction shares no words with the stored note, so search would miss it.
  const correction = source(value, "啊对，应该是i7-12700。");
  recordHomeMemoryInput(correction, "durable:71");
  const models = fauxHarnessModels();
  let seen = "";
  models.faux.setResponses([
    (context) => {
      seen = systemPromptOf(context);
      return fauxAssistantMessage(
        [
          fauxToolCall(HOME_CAPTURE_TOOL, {
            candidates: [
              candidate(correction, {
                content: "Homelab 主力机：i7-12700 CPU，16GB 内存。",
                scope: "homelab 硬件",
                slot: "homelab/hardware-main-machine",
                evidence: "应该是i7-12700",
                replacesId: note.id,
                expectedRevision: note.revision,
              }),
            ],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
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
  assert.match(seen, /i7-12900/, "the note under correction was not offered to the model");
  assert.match(seen, /homelab 硬件/, "the topic index did not reach the model");
  const updated = activeHomeMemories(value.userId, value.agentId).find(
    (row) => row.id === note.id,
  )!;
  assert.equal(updated.revision, 2);
  assert.match(updated.content, /i7-12700/);
  assert.equal(activeHomeMemories(value.userId, value.agentId).length, 1);
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
});

test("an answer in text is asked again as a forced tool call", async () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For this project, I prefer SQLite for metadata.");
  recordHomeMemoryInput(event, "durable:72");
  const models = fauxHarnessModels();
  let calls = 0;
  models.faux.setResponses([
    () => {
      calls++;
      return fauxAssistantMessage(JSON.stringify({ candidates: [] }));
    },
    () => {
      calls++;
      return fauxAssistantMessage(
        [
          fauxToolCall(HOME_CAPTURE_TOOL, {
            candidates: [candidate(event, { slot: "db/sqlite" })],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
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
  assert.equal(calls, 2);
  const overview = readHomeMemoryOverview(value.userId, value.agentId);
  assert.equal(overview.lastCapture?.route, "tool");
  assert.equal(overview.lastCapture?.saved, 1);
  assert.equal(overview.total, 1);
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
});

test("editing one message keeps the rest of the pending batch", () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const generation = readHomeMemorySettings(value.userId, value.agentId).generation;
  const keep = source(value, "For this project, I prefer SQLite for metadata.");
  const edited = source(value, "For Carmel, I prefer minimal UI labels.");
  recordHomeMemoryInput(keep, "durable:80");
  recordHomeMemoryInput(edited, "durable:81");
  invalidateHomeMemorySources(value.sessionId, ["durable:81"]);
  const rows = db.select().from(homeMemoryCaptures).all();
  assert.equal(rows.find((row) => row.eventId === edited.id)?.status, "skipped");
  assert.equal(rows.find((row) => row.eventId === keep.id)?.status, "pending");
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).generation, generation);
  const saved = commitHomeCapture(
    value.userId,
    value.agentId,
    generation,
    [keep, edited],
    [candidate(keep, { slot: "db/sqlite" }), candidate(edited, { slot: "carmel/labels" })],
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.sourceEventId, keep.id);
  const after = db.select().from(homeMemoryCaptures).all();
  assert.equal(after.find((row) => row.eventId === keep.id)?.status, "done");
  assert.equal(after.find((row) => row.eventId === edited.id)?.status, "skipped");
  // Leave no pending batch behind: the capture loop walks every automatic Home.
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
});

test("an explicit save leaves pending learning armed", () => {
  const value = fixture();
  setHomeMemorySettings(value.userId, value.agentId, { mode: "automatic" });
  const event = source(value, "For this project, I prefer SQLite for metadata.");
  recordHomeMemoryInput(event, "durable:82");
  const before = readHomeMemorySettings(value.userId, value.agentId).generation;
  saveHomeMemory(value.userId, value.agentId, { content: "An explicit independent fact" });
  assert.equal(readHomeMemorySettings(value.userId, value.agentId).generation, before);
  assert.equal(
    db.select().from(homeMemoryCaptures).where(eq(homeMemoryCaptures.eventId, event.id)).get()
      ?.status,
    "pending",
  );
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
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
    fauxAssistantMessage([fauxToolCall("memory_search", { query: "Saffron" })], {
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
    assert.ok(text.startsWith("{"), text);
    const output = JSON.parse(text);
    assert.equal(output.truncated, true);
    assert.ok(output.memories.length > 0 && output.memories.length <= 8);
    assert.ok(estimateTextTokens(text) < 2200);
  } finally {
    await harness.close();
  }
});

test("1-step memory tools save with until/replaces, edit by query, and forget by phrase; CJK queries recall naturally", async () => {
  const value = fixture();
  const event = source(value, "Remember I live in Pune and like 川菜.");
  const tools = createHomeMemoryTools(value.userId, value.agentId, value.sessionId, event.id);
  const save = tools.find((tool) => tool.name === "memory_save")!;
  const edit = tools.find((tool) => tool.name === "memory_edit")!;
  const forget = tools.find((tool) => tool.name === "memory_forget")!;
  const read = tools.find((tool) => tool.name === "memory_read")!;

  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  await save.execute(
    {
      content: "The user lives in Pune.",
      scope: "Location",
      placement: "core",
      until: tomorrow,
    },
    undefined as never,
    undefined as never,
  );
  await save.execute(
    {
      content: "用户最喜欢吃川菜和火锅。",
      scope: "饮食",
      aliases: ["晚餐", "餐厅"],
    },
    undefined as never,
    undefined as never,
  );
  // 1-step supersede via replaces on memory_save
  await save.execute(
    {
      content: "The user moved to Mumbai.",
      scope: "Location",
      placement: "core",
      replaces: "Pune",
    },
    undefined as never,
    undefined as never,
  );
  assert.equal(activeHomeMemories(value.userId, value.agentId).length, 2);
  assert.match(
    buildHomeMemorySections(value.userId, value.agentId, "Hi", 100000).home_memory_core!,
    /Mumbai/,
  );

  // Short CJK query (< 8 chars) triggers recall and matches CJK bigrams
  const cjkRecall = buildHomeMemorySections(value.userId, value.agentId, "今晚吃什么川菜", 100000);
  assert.match(cjkRecall.home_memory_recall!, /川菜和火锅/);

  // 1-step read and edit by query without needing ID or expectedRevision
  const readOut = await read.execute({ query: "川菜" }, undefined as never, undefined as never);
  assert.match(JSON.stringify(readOut), /川菜和火锅/);
  await edit.execute(
    {
      query: "Mumbai",
      patch: { content: "The user lives in Bengaluru." },
    },
    undefined as never,
    undefined as never,
  );
  assert.match(
    buildHomeMemorySections(value.userId, value.agentId, "Hi", 100000).home_memory_core!,
    /Bengaluru/,
  );

  // 1-step forget by phrase removes matching notes and prevents relearning
  const forgetOut = await forget.execute(
    { query: "Bengaluru" },
    undefined as never,
    undefined as never,
  );
  assert.equal(JSON.parse((forgetOut.output![0] as { text: string }).text).count, 1);
  assert.equal(
    isHomeMemoryForgotten(value.userId, value.agentId, {
      content: "The user lives in Bengaluru.",
      scope: "Location",
    }),
    true,
  );
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
});

test("capture includes assistant replies, keeps messages with attachments, and updates same-slot or explicit notes", async () => {
  const value = fixture();
  const explicitEvent = source(value, "Remember we use PostgreSQL for Saffron.");
  const explicitNote = saveHomeMemory(
    value.userId,
    value.agentId,
    { content: "Saffron uses PostgreSQL.", scope: "Saffron" },
    {
      origin: "explicit",
      eventId: explicitEvent.id,
      entryId: "durable:1",
      quote: explicitEvent.prompt.text,
      slot: "saffron/db",
    },
  );
  const turnEvent = db
    .insert(homeEvents)
    .values({
      id: crypto.randomUUID(),
      sessionId: value.sessionId,
      sourceKey: crypto.randomUUID(),
      kind: "input",
      origin: "web",
      prompt: {
        text: "Yes, let's switch Saffron to SQLite.",
        references: [{ kind: "file", path: "README.md" }],
      },
      reply: "Should we switch Saffron metadata from PostgreSQL to SQLite?",
      status: "done",
      createdAt: Date.now() + 20,
      finishedAt: Date.now() + 25,
    })
    .returning()
    .get();
  recordHomeMemoryInput(turnEvent, "durable:2");
  const models = fauxHarnessModels();
  let promptSeen = "";
  models.faux.setResponses([
    (context) => {
      promptSeen = systemPromptOf(context);
      return fauxAssistantMessage(
        [
          fauxToolCall(HOME_CAPTURE_TOOL, {
            candidates: [
              candidate(turnEvent, {
                content: "Saffron uses SQLite for metadata.",
                scope: "Saffron",
                kind: "decision",
                slot: "saffron/db",
                evidence: "switch Saffron to SQLite",
              }),
            ],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
  ]);
  await captureHomeMemories(Date.now() + 180000, async () => ({
    ok: true as const,
    value: {
      model: models.model,
      modelRuntime: models.models,
      modelRef: db.select().from(modelRefs).where(eq(modelRefs.id, value.modelRefId)).get()!,
    },
  }));
  assert.match(promptSeen, /assistantReply/);
  const notes = activeHomeMemories(value.userId, value.agentId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.id, explicitNote.id);
  assert.equal(notes[0]!.revision, 2);
  assert.match(notes[0]!.content, /SQLite/);
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
});

test("tidy removes expired notes, merges duplicates preserving signs/symbols, coalesces topics, organizes core, and resolves contradictions with remainder", async () => {
  const value = fixture();
  assert.equal(factIdentity("- The user is vegetarian."), "the user is vegetarian");
  assert.notEqual(factIdentity("Balance is -10"), factIdentity("Balance is 10"));
  assert.notEqual(factIdentity("Uses C"), factIdentity("Uses C++"));

  // 1. Expired note
  saveHomeMemory(value.userId, value.agentId, {
    content: "Temporary staging freeze.",
    expiresAt: Date.now() - 1000,
  });

  // 2. Duplicate notes (one automatic, one manual with aliases)
  const evt = source(value, "I prefer dark mode.");
  saveHomeMemory(
    value.userId,
    value.agentId,
    { content: "The user prefers dark mode.", scope: "" },
    { origin: "automatic", eventId: evt.id, entryId: "durable:1", quote: evt.prompt.text },
  );
  saveHomeMemory(value.userId, value.agentId, {
    content: "- The user prefers dark mode",
    scope: "UI",
    aliases: ["theme"],
    placement: "core",
  });

  // 3. Three fragmented automatic topic notes on the same scope -> coalesced
  for (const line of [
    "Saffron uses port 8080.",
    "Saffron deploys to fly.io.",
    "Saffron uses pnpm.",
  ]) {
    saveHomeMemory(
      value.userId,
      value.agentId,
      { content: line, scope: "Saffron", aliases: ["deploy"], placement: "topic" },
      { origin: "automatic", eventId: evt.id, entryId: "durable:1", quote: evt.prompt.text },
    );
  }

  // 4. Stale completed work log in core (> 14 days old) -> organized to topic
  const staleLog = saveHomeMemory(value.userId, value.agentId, {
    content: "Pull request #42 was merged and deployed.",
    scope: "Saffron",
    placement: "core",
  });
  db.update(homeMemories)
    .set({ updatedAt: Date.now() - 20 * 24 * 60 * 60_000 })
    .where(eq(homeMemories.id, staleLog.id))
    .run();

  // 5. Contradicting core notes where the older note has a still-true remainder clause
  const older = saveHomeMemory(value.userId, value.agentId, {
    content: "The user lives in Pune and speaks Marathi.",
    placement: "core",
  });
  const newer = saveHomeMemory(value.userId, value.agentId, {
    content: "The user moved to Tokyo.",
    placement: "core",
  });

  const models = fauxHarnessModels();
  const handleUpkeep = (context: Parameters<typeof systemPromptOf>[0]) => {
    const prompt = systemPromptOf(context);
    if (prompt.includes(ORGANIZE_MARKER)) return fauxAssistantMessage('{"moves": []}');
    if (prompt.includes(TIDY_MARKER)) {
      const lines = prompt.split("\n");
      const oldLine = lines.find((line) => line.includes("lives in Pune"));
      const newLine = lines.find((line) => line.includes("moved to Tokyo"));
      const oldIdx = Number(/^\[(\d+)\]/u.exec(oldLine ?? "")?.[1] ?? -1);
      const newIdx = Number(/^\[(\d+)\]/u.exec(newLine ?? "")?.[1] ?? -1);
      if (oldIdx >= 0 && newIdx >= 0) {
        return fauxAssistantMessage(
          JSON.stringify({
            pairs: [
              {
                a: oldIdx,
                b: newIdx,
                keep: "b",
                remainder: "The user speaks Marathi.",
              },
            ],
          }),
        );
      }
    }
    return fauxAssistantMessage('{"pairs": []}');
  };
  models.faux.setResponses([handleUpkeep, handleUpkeep, handleUpkeep]);

  const report = await tidyHomeMemories(value.userId, value.agentId, Date.now(), async () => ({
    ok: true as const,
    value: {
      model: models.model,
      modelRuntime: models.models,
      modelRef: db.select().from(modelRefs).where(eq(modelRefs.id, value.modelRefId)).get()!,
    },
  }));

  assert.equal(report.expired, 1);
  assert.equal(report.duplicates, 1);
  assert.equal(report.coalesced, 2);
  assert.equal(report.organized, 1);
  assert.equal(report.superseded, 1);
  assert.equal(report.contradictionsChecked, true);

  const active = activeHomeMemories(value.userId, value.agentId);
  const updatedOlder = active.find((note) => note.id === older.id)!;
  assert.equal(updatedOlder.content, "The user speaks Marathi.");
  assert.equal(
    homeMemoryHistory(value.userId, value.agentId, older.id).some((rev) =>
      rev.content.includes("lives in Pune"),
    ),
    true,
  );
  assert.ok(active.some((note) => note.id === newer.id));
  const saffronNotes = active.filter((note) => note.scope === "Saffron");
  assert.equal(saffronNotes.length, 2); // 1 coalesced note + 1 moved stale work log
  assert.match(saffronNotes[0]!.content, /port 8080[\s\S]*fly\.io[\s\S]*pnpm/);
  setHomeMemorySettings(value.userId, value.agentId, { mode: "manual" });
});

test("dreams consolidate cross-session patterns with fact checks, and shared aboutUser memories reach the user's other agents", async () => {
  const userId = createUser();
  const agentA = createSession({ userId });
  ensureHome(userId, agentA.agentId);
  const agentB = createSession({ userId });
  db.update(agents).set({ shared: true }).where(eq(agents.id, agentB.agentId)).run();
  ensureHome(userId, agentB.agentId);
  const otherUser = createUser();
  ensureHome(otherUser, agentB.agentId);

  // Add a second conversation on agentA so dream has 2 conversations
  const secondSession = createSession({ userId });
  db.update(sessions)
    .set({ agentId: agentA.agentId, title: "Release checklist", updatedAt: Date.now() })
    .where(eq(sessions.id, secondSession.sessionId))
    .run();
  sqlite
    .prepare("INSERT INTO session_search(session_id, entry_id, text) VALUES (?, ?, ?)")
    .run(
      agentA.sessionId,
      "durable:1",
      "Please keep summaries under 80 words and I am based in Kyoto.",
    );
  sqlite
    .prepare("INSERT INTO session_search(session_id, entry_id, text) VALUES (?, ?, ?)")
    .run(
      secondSession.sessionId,
      "durable:1",
      "Again, keep summaries under 80 words when reviewing.",
    );

  assert.equal(
    checkDreamFacts(
      "The user wants summaries under 80 words.",
      [1, 2],
      ["keep summaries under 80 words", "keep summaries under 80 words"],
      [
        {
          sessionId: "s1",
          title: "A",
          lines: [{ by: "user", text: "Please keep summaries under 80 words." }],
        },
        {
          sessionId: "s2",
          title: "B",
          lines: [{ by: "user", text: "Again, keep summaries under 80 words." }],
        },
      ],
    ),
    true,
  );
  // Fabricated number (50 instead of 80) is rejected by checkDreamFacts
  assert.equal(
    checkDreamFacts(
      "The user wants summaries under 50 words.",
      [1, 2],
      ["keep summaries under 80 words", "keep summaries under 80 words"],
      [
        {
          sessionId: "s1",
          title: "A",
          lines: [{ by: "user", text: "Please keep summaries under 80 words." }],
        },
        {
          sessionId: "s2",
          title: "B",
          lines: [{ by: "user", text: "Again, keep summaries under 80 words." }],
        },
      ],
    ),
    false,
  );

  const models = fauxHarnessModels();
  models.faux.setResponses([
    (context) => {
      assert.match(systemPromptOf(context), new RegExp(DREAM_MARKER));
      return fauxAssistantMessage(
        JSON.stringify({
          learned: [
            {
              text: "The user wants summaries under 80 words.",
              from: [1, 2],
              evidence: ["keep summaries under 80 words", "keep summaries under 80 words"],
              aboutUser: true,
              confidence: 0.9,
            },
          ],
          outdated: [],
          ideas: [
            {
              text: "Set up a scheduled weekly release checklist task.",
              from: [1, 2],
            },
          ],
        }),
      );
    },
  ]);

  const dream = await dreamHomeMemories(userId, agentA.agentId, Date.now(), async () => ({
    ok: true as const,
    value: {
      model: models.model,
      modelRuntime: models.models,
      modelRef: db.select().from(modelRefs).where(eq(modelRefs.id, agentA.modelRefId)).get()!,
    },
  }));
  assert.equal(dream.learned.length, 1);
  assert.equal(dream.aboutMe, 1);
  assert.equal(dream.ideas.length, 1);

  // Agent B (owned by the same user) receives the shared aboutUser preference in core and overview
  const agentBSections = buildHomeMemorySections(userId, agentB.agentId, "Hello", 100000);
  assert.match(agentBSections.home_memory_core!, /summaries under 80 words/);
  const agentBOverview = readHomeMemoryOverview(userId, agentB.agentId);
  assert.equal(agentBOverview.sharedMemories?.length, 1);

  // Another user never sees userId's shared aboutUser memories
  assert.equal(
    buildHomeMemorySections(otherUser, agentB.agentId, "Hello", 100000).home_memory_core,
    undefined,
  );

  // Forgetting the shared memory from Agent B removes it everywhere for userId
  const sharedNote = agentBOverview.sharedMemories![0]!;
  await forgetHomeMemory(userId, agentB.agentId, sharedNote.id, sharedNote.revision);
  assert.equal(readHomeMemoryOverview(userId, agentA.agentId).total, 0);
  assert.equal(readHomeMemoryOverview(userId, agentB.agentId).sharedMemories?.length, 0);

  // Verify POST /agents/:agentId/home/memory/tidy route
  const app = appFor(userId);
  const res = await app.request(`/agents/${agentA.agentId}/home/memory/tidy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dream: false }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tidy: { expired: number } };
  assert.equal(typeof body.tidy.expired, "number");
});
