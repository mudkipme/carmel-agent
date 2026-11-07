import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

const root = await mkdtemp(join(tmpdir(), "carmel-memory-merge-"));
process.env.CARMEL_AGENT_DATA_DIR = root;
process.env.DATABASE_URL = ":memory:";
process.env.CARMEL_KNOWLEDGE_EMBED_MODEL = "";
process.env.CARMEL_PODMAN_SOCKET = join(root, "unavailable.sock");
const { db, initialize } = await import("../db/index.ts");
const { agents, homeMemorySettings, knowledgeConfigs, knowledgeMemories, homeEvents } =
  await import("../db/schema.ts");
const { createSession, createUser } = await import("../test-support.ts");
const memory = await import("./home-memory.ts");
const { migrateAgentMemories } = await import("./home-memory-migration.ts");
const {
  knowledgeDir,
  knowledgeOverview,
  addKnowledgeSource,
  saveKnowledgeSettings,
  readKnowledge,
} = await import("./knowledge.ts");
const {
  searchHomeMemory,
  refreshHomeMemoryIndex,
  waitHomeMemoryIndexJob,
  homeMemoryWorkerPlan,
  homeMemoryDocument,
  recallHomeMemories,
} = await import("./home-memory-search.ts");
const { knowledgeLock } = await import("../runtime/knowledge/queue.ts");
const { homeMemoryPassage } = await import("./home-memory-passages.ts");
const { homeMemoryIndexDir, homeMemoryIndexKey, emptyMemoryIndexStatus } =
  await import("./home-memory-index.ts");
const { knowledgeContainerSpec } = await import("../runtime/knowledge/worker-client.ts");
const { ensureHome } = await import("./agent-homes.ts");
const { buildHomeMemorySections, createHomeMemoryTools } =
  await import("../runtime/home-memory-tools.ts");
const { createKnowledgeTools } = await import("../runtime/knowledge/tools.ts");
initialize();
after(() => rm(root, { recursive: true, force: true }));

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const indexed = { documents: 1, needsEmbedding: 0, backend: "cpu", devices: [] };
const whereHome = (userId: string, agentId: string) =>
  and(eq(homeMemorySettings.userId, userId), eq(homeMemorySettings.agentId, agentId));

function fixture() {
  const value = createSession();
  db.update(agents).set({ shared: true }).where(eq(agents.id, value.agentId)).run();
  return value;
}

function enableIndex(userId: string, agentId: string) {
  memory.setHomeMemorySettings(userId, agentId, {
    retrieval: { enabled: true, acceleration: "cpu" },
  });
  db.update(homeMemorySettings)
    .set({
      indexStatus: {
        ...emptyMemoryIndexStatus,
        ...indexed,
        state: "ready",
        lastUpdatedAt: Date.now(),
      },
      indexDirty: false,
    })
    .where(whereHome(userId, agentId))
    .run();
}

async function legacyNote(
  value: ReturnType<typeof fixture>,
  content: string,
  changes: { pendingContent?: string; deletedAt?: number } = {},
) {
  const contributorId = createUser();
  const id = `m${crypto.randomUUID().replaceAll("-", "")}`;
  const title = "A long project decision";
  const raw = `# ${title}\n\n${content}`;
  await mkdir(join(knowledgeDir(value.agentId), "notes"), { recursive: true });
  await writeFile(join(knowledgeDir(value.agentId), "notes", `${id}.md`), raw);
  db.insert(knowledgeMemories)
    .values({
      id,
      agentId: value.agentId,
      title,
      contributorId,
      revision: digest(changes.pendingContent ?? raw),
      createdAt: 10,
      updatedAt: 20,
      ...changes,
    })
    .run();
  db.insert(knowledgeConfigs)
    .values({
      agentId: value.agentId,
      settings: { enabled: true, acceleration: "cpu" },
      status: emptyMemoryIndexStatus,
      dirty: false,
      memoriesMigrated: false,
    })
    .onConflictDoUpdate({ target: knowledgeConfigs.agentId, set: { memoriesMigrated: false } })
    .run();
  return { id, title, contributorId, raw };
}

test("legacy agent notes move to the owner's private Home without losing long content or provenance", async () => {
  const value = fixture();
  memory.setHomeMemorySettings(value.userId, value.agentId, { mode: "off" });
  const content = "Preserve this entire Markdown note.\n".repeat(500);
  const legacy = await legacyNote(value, content);
  await mkdir(join(knowledgeDir(value.agentId), "index"), { recursive: true });
  await writeFile(
    join(knowledgeDir(value.agentId), "index", "old.sqlite"),
    "shared derived memory",
  );
  const source = join(root, "references");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "guide.md"), "# A reference\n\nKeep this source.");
  db.update(agents).set({ workingDir: source }).where(eq(agents.id, value.agentId)).run();
  const registered = await addKnowledgeSource(value.userId, value.agentId, {
    name: "References",
    path: source,
  });
  await migrateAgentMemories();
  const note = memory.readHomeMemory(value.userId, value.agentId, legacy.id);
  assert.equal(note.content, content);
  assert.equal(note.title, legacy.title);
  assert.equal(note.contributorId, legacy.contributorId);
  assert.equal(note.legacyRevision, digest(legacy.raw));
  assert.equal(note.createdAt, 10);
  assert.equal(note.updatedAt, 20);
  assert.equal(note.placement, "topic");
  assert.equal(note.origin, "manual");
  assert.equal(memory.readHomeMemorySettings(value.userId, value.agentId).mode, "off");
  assert.equal(memory.readHomeMemorySettings(value.userId, value.agentId).retrieval.enabled, true);
  assert.deepEqual(memory.readHomeMemoryOverview(value.userId, value.agentId).coreIds, []);
  assert.equal(memory.readHomeMemoryOverview(legacy.contributorId, value.agentId).total, 0);
  assert.throws(
    () => memory.readHomeMemory(legacy.contributorId, value.agentId, legacy.id),
    /not found/,
  );
  assert.equal(
    db.select().from(knowledgeMemories).where(eq(knowledgeMemories.id, legacy.id)).get(),
    undefined,
  );
  await assert.rejects(stat(join(knowledgeDir(value.agentId), "index")), { code: "ENOENT" });
  await assert.rejects(stat(join(knowledgeDir(value.agentId), "notes")), { code: "ENOENT" });
  assert.equal(
    (await knowledgeOverview(value.userId, value.agentId)).sources[0]?.id,
    registered.id,
  );
  await assert.rejects(
    readKnowledge(value.userId, value.agentId, { sourceId: "memories", path: `${legacy.id}.md` }),
    /not found/,
  );
  memory.editHomeMemory(value.userId, value.agentId, legacy.id, {
    expectedRevision: 1,
    title: "Owner's corrected title",
  });
  await migrateAgentMemories();
  assert.equal(
    memory.readHomeMemory(value.userId, value.agentId, legacy.id).contributorId,
    legacy.contributorId,
  );
  assert.equal(memory.readHomeMemoryOverview(value.userId, value.agentId).total, 1);
  assert.equal(
    memory.readHomeMemory(value.userId, value.agentId, legacy.id).title,
    "Owner's corrected title",
  );
});

test("migration replays pending note content, skips deleted notes, and retains unreadable originals", async () => {
  const value = fixture();
  const pending = "# A long project decision\n\nThe pending update is authoritative.";
  const first = await legacyNote(value, "An older copy.", { pendingContent: pending });
  const deleted = await legacyNote(value, "Do not resurrect this note.", { deletedAt: 30 });
  await migrateAgentMemories();
  assert.equal(
    memory.readHomeMemory(value.userId, value.agentId, first.id).content,
    "The pending update is authoritative.",
  );
  assert.throws(() => memory.readHomeMemory(value.userId, value.agentId, deleted.id), /not found/);
  const broken = fixture();
  const missing = await legacyNote(broken, "Original must survive failure.");
  await rm(join(knowledgeDir(broken.agentId), "notes", `${missing.id}.md`));
  await assert.rejects(migrateAgentMemories(), { code: "ENOENT" });
  assert.ok(db.select().from(knowledgeMemories).where(eq(knowledgeMemories.id, missing.id)).get());
  await writeFile(join(knowledgeDir(broken.agentId), "notes", `${missing.id}.md`), missing.raw);
  await migrateAgentMemories();
  assert.equal(
    memory.readHomeMemory(broken.userId, broken.agentId, missing.id).content,
    "Original must survive failure.",
  );
});

test("Home workers isolate indexes and mounts by user and agent while reusing only model weights", async () => {
  const value = fixture(),
    other = createUser();
  enableIndex(value.userId, value.agentId);
  enableIndex(other, value.agentId);
  const first = await homeMemoryWorkerPlan(value.userId, value.agentId);
  const second = await homeMemoryWorkerPlan(other, value.agentId);
  assert.notEqual(first.scopeKey, second.scopeKey);
  assert.notEqual(first.stateDir, second.stateDir);
  assert.notEqual(first.scopeKey, value.agentId);
  assert.equal(first.modelCacheDir, second.modelCacheDir);
  assert.equal(first.sources.length, 1);
  assert.equal(first.sources[0]?.hostPath, join(first.stateDir, "notes"));
  const identity = { user: "1000:1000", usernsMode: "keep-id" };
  const spec = knowledgeContainerSpec(
    first,
    identity as Parameters<typeof knowledgeContainerSpec>[1],
  );
  assert.ok(spec.HostConfig.Binds.some((bind) => bind.includes(`${first.stateDir}:/state:rw`)));
  assert.ok(spec.HostConfig.Binds.every((bind) => !bind.includes(second.stateDir)));
  assert.equal(spec.Labels["carmel.retrieval.scope"], first.scopeKey);
});

test("semantic results validate current private notes and fall back to keyword search", async () => {
  const value = fixture(),
    other = createUser();
  const own = memory.saveHomeMemory(value.userId, value.agentId, {
    title: "Meals",
    content: "Prefer lentil dishes.",
  });
  const foreign = memory.saveHomeMemory(other, value.agentId, {
    content: "Another person's private fact.",
  });
  enableIndex(value.userId, value.agentId);
  const worker = async (plan: Awaited<ReturnType<typeof homeMemoryWorkerPlan>>) => {
    assert.equal(plan.scopeKey, homeMemoryIndexKey(value.userId, value.agentId));
    return {
      ...indexed,
      hits: [
        {
          sourceId: "memories",
          path: `${foreign.id}.md`,
          hash: digest(homeMemoryDocument(foreign)),
          score: 1,
        },
        {
          sourceId: "memories",
          path: `${own.id}.md`,
          hash: digest(homeMemoryDocument(own)),
          score: 0.9,
        },
      ],
    };
  };
  const result = await searchHomeMemory(
    value.userId,
    value.agentId,
    { query: "What should I eat?", mode: "semantic" },
    undefined,
    worker,
  );
  assert.deepEqual(
    result.memories.map((note) => note.id),
    [own.id],
  );
  assert.equal(result.mode, "semantic");
  assert.match(
    buildHomeMemorySections(
      value.userId,
      value.agentId,
      "What should I eat?",
      100000,
      result.memories,
    ).home_memory_recall!,
    /lentil/,
  );
  memory.editHomeMemory(value.userId, value.agentId, own.id, {
    expectedRevision: 1,
    content: "Prefer mushroom dishes.",
  });
  const stale = await searchHomeMemory(
    value.userId,
    value.agentId,
    { query: "lentil", mode: "semantic" },
    undefined,
    worker,
  );
  assert.deepEqual(stale.memories, []);
  assert.match(stale.warning!, /refresh/);
  const fallback = await searchHomeMemory(
    value.userId,
    value.agentId,
    { query: "mushroom", mode: "deep" },
    undefined,
    async () => {
      throw new Error("Model is not cached.");
    },
  );
  assert.equal(fallback.mode, "fast");
  assert.equal(fallback.memories[0]?.id, own.id);
  assert.match(fallback.warning!, /not cached/);
  memory.setHomeMemorySettings(value.userId, value.agentId, { mode: "off" });
  assert.deepEqual(
    (
      await searchHomeMemory(
        value.userId,
        value.agentId,
        { query: "mushroom", mode: "semantic" },
        undefined,
        worker,
      )
    ).memories,
    [],
  );
});

test("automatic recall falls back within its deadline while Home indexing holds the queue", async () => {
  const value = fixture();
  const note = memory.saveHomeMemory(value.userId, value.agentId, {
    content: "Zephyrflux uses SQLite.",
  });
  enableIndex(value.userId, value.agentId);
  let release!: () => void;
  const indexing = knowledgeLock(
    homeMemoryIndexKey(value.userId, value.agentId),
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  let result: Awaited<ReturnType<typeof recallHomeMemories>> | undefined;
  const recall = recallHomeMemories(value.userId, value.agentId, "Zephyrflux database").then(
    (notes) => {
      result = notes;
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 5200));
    assert.deepEqual(
      result?.map((item) => item.id),
      [note.id],
    );
  } finally {
    release();
    await Promise.all([recall, indexing]);
  }
});

test("a Home search waiting for shared GPU work aborts without starting a worker later", async () => {
  const value = fixture();
  memory.saveHomeMemory(value.userId, value.agentId, { content: "Zephyrflux uses SQLite." });
  enableIndex(value.userId, value.agentId);
  let release!: () => void;
  const embedding = knowledgeLock(
    "$gpu",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  let workerCalled = false;
  let error: unknown;
  const search = searchHomeMemory(
    value.userId,
    value.agentId,
    { query: "Zephyrflux", mode: "semantic" },
    controller.signal,
    async () => {
      workerCalled = true;
      return { ...indexed, hits: [] };
    },
  );
  void search.catch((reason) => {
    error = reason;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("Recall deadline expired"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(error, controller.signal.reason);
    assert.equal(workerCalled, false);
  } finally {
    release();
    await Promise.allSettled([embedding, search]);
  }
  await knowledgeLock("$gpu", async () => {});
  assert.equal(workerCalled, false);
});

test("long-note keyword recall and memory_search return the matching passage with readable line ranges", async () => {
  const value = fixture();
  const home = ensureHome(value.userId, value.agentId);
  const fact = "The zephyrflux migration target is February 23.";
  const note = memory.saveHomeMemory(value.userId, value.agentId, {
    title: "Migration decisions",
    scope: "Project",
    aliases: ["migration"],
    content:
      "General migration introduction.\n".repeat(200) + fact + "\nBackground detail.\n".repeat(80),
  });
  const query = "zephyrflux migration target";
  const sections = buildHomeMemorySections(value.userId, value.agentId, query, 128000);
  const [recalled] = JSON.parse(sections.home_memory_recall!);
  assert.equal(recalled.id, note.id);
  assert.ok(recalled.content.includes(fact));
  assert.ok(recalled.content.length <= 600);
  assert.ok(recalled.fromLine > 1);
  assert.ok(recalled.fromLine <= 201 && recalled.toLine >= 201);
  const event = db
    .insert(homeEvents)
    .values({
      id: crypto.randomUUID(),
      sessionId: home.sessionId,
      sourceKey: crypto.randomUUID(),
      kind: "input",
      origin: "web",
      prompt: { text: query },
      status: "done",
      createdAt: Date.now(),
    })
    .returning()
    .get();
  const tools = createHomeMemoryTools(value.userId, value.agentId, home.sessionId, event.id);
  const output = await tools
    .find((tool) => tool.name === "memory_search")!
    .execute({ query }, undefined as never, undefined as never);
  const response = JSON.parse((output.output![0] as { text: string }).text);
  const [passage] = response.memories;
  assert.ok(passage.content.includes(fact));
  assert.ok(passage.content.length <= 1200);
  assert.equal(response.truncated, true);
  const read = await tools
    .find((tool) => tool.name === "memory_read")!
    .execute(
      { id: note.id, fromLine: passage.fromLine, maxLines: passage.toLine - passage.fromLine + 1 },
      undefined as never,
      undefined as never,
    );
  assert.match(JSON.stringify(read), /February 23/);
  assert.equal(memory.readHomeMemory(value.userId, value.agentId, note.id).content, note.content);
  const paragraph = { ...note, content: "General background. ".repeat(300) + fact };
  assert.ok(homeMemoryPassage(paragraph, query, 600).content.includes(fact));
});

test("semantic passage locations survive document headers and select facts without shared query words", async () => {
  const value = fixture();
  const fact = "Pack waterproof walking boots for the trail.";
  const note = memory.saveHomeMemory(value.userId, value.agentId, {
    title: "旅行 🥾",
    scope: "Packing",
    content: "General packing background.\n".repeat(220) + fact + "\nOther details.\n".repeat(50),
  });
  enableIndex(value.userId, value.agentId);
  const document = homeMemoryDocument(note);
  const start = document.indexOf(fact);
  const result = await searchHomeMemory(
    value.userId,
    value.agentId,
    { query: "rainy hike", mode: "semantic" },
    undefined,
    async () => ({
      ...indexed,
      hits: [
        {
          sourceId: "memories",
          path: `${note.id}.md`,
          hash: digest(document),
          score: 0.9,
          match: { start, end: start + fact.length },
        },
      ],
    }),
  );
  assert.equal(result.memories[0]?.content, note.content);
  assert.deepEqual(result.memories[0]?.match, {
    start: note.content.indexOf(fact),
    end: note.content.indexOf(fact) + fact.length,
  });
  const section = buildHomeMemorySections(
    value.userId,
    value.agentId,
    "rainy hike",
    128000,
    result.memories,
  ).home_memory_recall!;
  assert.ok(section.includes(fact));
  assert.equal(JSON.parse(section)[0].fromLine, 221);
  const stale = await searchHomeMemory(
    value.userId,
    value.agentId,
    { query: "rainy hike", mode: "deep" },
    undefined,
    async () => ({
      ...indexed,
      hits: [
        {
          sourceId: "memories",
          path: `${note.id}.md`,
          hash: "stale",
          score: 0.9,
          match: { start, end: start + fact.length },
        },
      ],
    }),
  );
  assert.deepEqual(stale.memories, []);
});

test("index refresh mirrors current notes and preserves dirty state when capture changes a note", async () => {
  const value = fixture();
  const note = memory.saveHomeMemory(value.userId, value.agentId, {
    title: "Project note",
    content: "Original version.",
  });
  enableIndex(value.userId, value.agentId);
  const seen: string[] = [];
  await refreshHomeMemoryIndex(
    value.userId,
    value.agentId,
    { embed: true },
    async (plan, request) => {
      seen.push(String(request.op));
      assert.equal(
        await readFile(join(plan.stateDir, "notes", `${note.id}.md`), "utf8"),
        homeMemoryDocument(note),
      );
      if (request.op === "update")
        memory.editHomeMemory(value.userId, value.agentId, note.id, {
          expectedRevision: 1,
          content: "Updated while indexing.",
        });
      return indexed;
    },
  );
  await waitHomeMemoryIndexJob(value.userId, value.agentId);
  assert.deepEqual(seen, ["update", "embed"]);
  assert.equal(memory.readHomeMemorySettings(value.userId, value.agentId).indexDirty, true);
  assert.equal(
    memory.readHomeMemorySettings(value.userId, value.agentId).indexStatus?.state,
    "ready",
  );
  await refreshHomeMemoryIndex(value.userId, value.agentId, {}, async () => ({
    ...indexed,
    backend: null,
  }));
  await waitHomeMemoryIndexJob(value.userId, value.agentId);
  assert.equal(
    memory.readHomeMemorySettings(value.userId, value.agentId).indexStatus?.backend,
    "cpu",
  );
  await memory.forgetHomeMemory(value.userId, value.agentId, note.id, 2);
  await assert.rejects(stat(homeMemoryIndexDir(value.userId, value.agentId)), { code: "ENOENT" });
  assert.equal(memory.readHomeMemorySettings(value.userId, value.agentId).indexStatus, null);
});

test("Home has one memory tool set with long-note reads and exact edits; Knowledge has no memory tools", async () => {
  const value = fixture();
  const home = ensureHome(value.userId, value.agentId);
  const event = db
    .insert(homeEvents)
    .values({
      id: crypto.randomUUID(),
      sessionId: home.sessionId,
      sourceKey: crypto.randomUUID(),
      kind: "input",
      origin: "web",
      prompt: { text: "Remember this." },
      status: "done",
      createdAt: Date.now(),
    })
    .returning()
    .get();
  const tools = createHomeMemoryTools(value.userId, value.agentId, home.sessionId, event.id);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["memory_search", "memory_read", "memory_save", "memory_edit", "memory_forget"],
  );
  assert.deepEqual(
    createHomeMemoryTools(value.userId, value.agentId, value.sessionId, event.id),
    [],
  );
  await saveKnowledgeSettings(value.userId, value.agentId, { enabled: true, acceleration: "cpu" });
  assert.deepEqual(
    createKnowledgeTools(value.userId, value.agentId).map((tool) => tool.name),
    ["knowledge_search", "knowledge_read"],
  );
  const note = memory.saveHomeMemory(value.userId, value.agentId, {
    title: "Long note",
    content: Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"long content ".repeat(5)}`).join(
      "\n",
    ),
  });
  assert.ok(note.content.length > 2000);
  const read = tools.find((tool) => tool.name === "memory_read")!;
  const result = await read.execute(
    { id: note.id, fromLine: 150, maxLines: 2 },
    undefined as never,
    undefined as never,
  );
  assert.match(JSON.stringify(result), /Line 149:/);
  assert.doesNotMatch(JSON.stringify(result), /Line 148:/);
  const edit = tools.find((tool) => tool.name === "memory_edit")!;
  await edit.execute(
    {
      id: note.id,
      expectedRevision: 1,
      edits: [{ oldText: "Line 150:", newText: "Corrected line 150:" }],
    },
    undefined as never,
    undefined as never,
  );
  assert.match(
    memory.readHomeMemory(value.userId, value.agentId, note.id).content,
    /Corrected line 150:/,
  );
  await assert.rejects(
    edit.execute(
      { id: note.id, expectedRevision: 1, patch: { title: "Stale edit" } },
      undefined as never,
      undefined as never,
    ),
    /changed/,
  );
});
