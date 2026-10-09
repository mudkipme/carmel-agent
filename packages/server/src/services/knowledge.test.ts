import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";

const root = await mkdtemp(join(tmpdir(), "carmel-knowledge-unit-"));
process.env.CARMEL_AGENT_DATA_DIR = root;
process.env.DATABASE_URL = ":memory:";
process.env.CARMEL_KNOWLEDGE_EMBED_MODEL = "";
process.env.CARMEL_PODMAN_SOCKET = join(root, "unavailable.sock");
const { db, initialize } = await import("../db/index.ts");
const { agents, knowledgeMemories, knowledgeConfigs } =
  await import("../db/schema.ts");
const { createSession, createUser } = await import("../test-support.ts");
const { createKnowledgeTools } = await import("../runtime/knowledge/tools.ts");
const knowledge = await import("./knowledge.ts");
initialize();
after(() => rm(root, { recursive: true, force: true }));

test("all agents use the operator's model and shared cache, ignoring legacy per-agent overrides", async () => {
  const { knowledgeModelPlan } = await import("../runtime/knowledge/models.ts");
  const original = process.env.CARMEL_KNOWLEDGE_EMBED_MODEL;
  try {
    const a = await fixture(),
      b = await fixture();
    const localModel = join(root, "Qwen3-Embedding-shared.gguf");
    await writeFile(localModel, "test model metadata");
    process.env.CARMEL_KNOWLEDGE_EMBED_MODEL = localModel;
    const legacy = {
      enabled: true,
      acceleration: "cpu" as const,
      embeddingModel: "/obsolete/agent-model.gguf",
    };
    db.update(knowledgeConfigs)
      .set({ settings: legacy })
      .where(eq(knowledgeConfigs.agentId, a.agentId))
      .run();
    const first = await knowledge.knowledgeOverview(a.userId, a.agentId);
    const second = await knowledge.knowledgeOverview(b.userId, b.agentId);
    assert.equal(first.embeddingModel, localModel);
    assert.equal(second.embeddingModel, localModel);
    assert.equal("embeddingModel" in first.settings, false);
    const model = await knowledgeModelPlan();
    assert.equal(model.model?.hostPath, localModel);
    assert.equal(
      model.model?.containerPath,
      "/models/local/Qwen3-Embedding-shared.gguf",
    );
    const cached = join(model.modelCacheDir, "shared.gguf");
    await writeFile(cached, "shared weights");
    await knowledge.deleteAgentKnowledge(a.agentId);
    assert.equal(await readFile(cached, "utf8"), "shared weights");
    process.env.CARMEL_KNOWLEDGE_EMBED_MODEL = "relative.gguf";
    await assert.rejects(knowledgeModelPlan(), /absolute GGUF/);
  } finally {
    process.env.CARMEL_KNOWLEDGE_EMBED_MODEL = original;
  }
});

async function fixture() {
  const row = createSession();
  const workspace = join(root, row.agentId, "workspace");
  await mkdir(workspace, { recursive: true });
  db.update(agents)
    .set({
      shared: true,
      workingDir: workspace,
      permissions: {
        read: true,
        write: true,
        edit: true,
        bash: false,
        network: false,
      },
    })
    .where(eq(agents.id, row.agentId))
    .run();
  await knowledge.saveKnowledgeSettings(row.userId, row.agentId, {
    enabled: true,
    acceleration: "cpu",
  });
  return { ...row, workspace };
}

test("agent memory is shared across users, with conflict checks and immediate forgetting", async () => {
  const a = await fixture(),
    bob = createUser();
  const saved = await knowledge.saveMemory(a.userId, a.agentId, {
    title: "Budget meeting",
    content: "Alice and Bob meet on Sunday.",
  });
  assert.equal(
    (await knowledge.knowledgeOverview(bob, a.agentId)).memories[0]
      ?.contributorId,
    a.userId,
  );
  const updated = await knowledge.saveMemory(
    bob,
    a.agentId,
    {
      title: saved.title,
      content: "The family meets on Monday.",
      expectedRevision: saved.revision,
    },
    saved.id,
  );
  assert.equal(updated.contributorId, bob);
  await assert.rejects(
    knowledge.saveMemory(
      a.userId,
      a.agentId,
      {
        title: saved.title,
        content: "Stale edit",
        expectedRevision: saved.revision,
      },
      saved.id,
    ),
    { status: 409 },
  );
  const doc = await knowledge.readKnowledge(a.userId, a.agentId, {
    sourceId: "memories",
    path: `${saved.id}.md`,
  });
  assert.match(doc.content, /Monday/);
  assert.equal(doc.revision, updated.revision);
  // A previous index generation must not retain forgotten content.
  const index = join(knowledge.knowledgeDir(a.agentId), "index");
  await mkdir(index);
  await writeFile(join(index, "old.sqlite"), "derived memory");
  await knowledge.forgetMemory(a.userId, a.agentId, saved.id, updated.revision);
  await assert.rejects(
    knowledge.readKnowledge(bob, a.agentId, {
      sourceId: "memories",
      path: `${saved.id}.md`,
    }),
    { status: 404 },
  );
  await assert.rejects(readFile(join(index, "old.sqlite")), { code: "ENOENT" });
  assert.equal(
    (await knowledge.knowledgeOverview(bob, a.agentId)).memories.length,
    0,
  );
});

test("knowledge rechecks agent sharing and permissions; configuration remains owner-only", async () => {
  const a = await fixture(),
    bob = createUser();
  await assert.rejects(
    knowledge.saveKnowledgeSettings(bob, a.agentId, {
      enabled: false,
      acceleration: "cpu",
    }),
    { status: 403 },
  );
  assert.deepEqual(
    createKnowledgeTools(bob, a.agentId).map((t) => t.name),
    ["knowledge_search", "knowledge_read", "memory_save", "memory_forget"],
  );
  db.update(agents)
    .set({ shared: false })
    .where(eq(agents.id, a.agentId))
    .run();
  await assert.rejects(knowledge.knowledgeOverview(bob, a.agentId), {
    status: 404,
  });
  assert.equal(createKnowledgeTools(bob, a.agentId).length, 0);
  db.update(agents)
    .set({
      permissions: {
        read: true,
        write: false,
        edit: false,
        bash: false,
        network: false,
      },
    })
    .where(eq(agents.id, a.agentId))
    .run();
  await assert.rejects(
    knowledge.saveMemory(a.userId, a.agentId, {
      title: "Denied",
      content: "No write permission",
    }),
    { status: 403 },
  );
  assert.deepEqual(
    createKnowledgeTools(a.userId, a.agentId).map((t) => t.name),
    ["knowledge_search", "knowledge_read"],
  );
  db.update(agents)
    .set({
      permissions: {
        read: false,
        write: false,
        edit: false,
        bash: false,
        network: false,
      },
    })
    .where(eq(agents.id, a.agentId))
    .run();
  await assert.rejects(knowledge.knowledgeOverview(a.userId, a.agentId), {
    status: 403,
  });
});

test("source reads reject traversal, escaping symlinks and disconnected references", async () => {
  const a = await fixture();
  const outside = join(root, "outside.md");
  await writeFile(outside, "private");
  await writeFile(join(a.workspace, "family.md"), "# Family\nPublic notes");
  await symlink(outside, join(a.workspace, "escape.md"));
  const source = await knowledge.addKnowledgeSource(a.userId, a.agentId, {
    name: "Family",
    path: a.workspace,
  });
  const ref = { sourceId: source.id, path: "family.md" };
  assert.match(
    (await knowledge.readKnowledge(a.userId, a.agentId, ref)).content,
    /Public notes/,
  );
  await assert.rejects(
    knowledge.readKnowledge(a.userId, a.agentId, {
      ...ref,
      path: "../outside.md",
    }),
    { status: 400 },
  );
  await assert.rejects(
    knowledge.readKnowledge(a.userId, a.agentId, { ...ref, path: "escape.md" }),
    { status: 403 },
  );
  await assert.rejects(
    knowledge.addKnowledgeSource(a.userId, a.agentId, {
      name: "Outside",
      path: "..",
    }),
    { status: 403 },
  );
  await knowledge.deleteKnowledgeSource(a.userId, a.agentId, source.id);
  await assert.rejects(knowledge.readKnowledge(a.userId, a.agentId, ref), {
    status: 404,
  });
});

test("pending memory writes recover before subsequent mutations without indexing partial files", async () => {
  const a = await fixture();
  const saved = await knowledge.saveMemory(a.userId, a.agentId, {
    title: "Original",
    content: "One",
  });
  const path = join(
    knowledge.knowledgeDir(a.agentId),
    "notes",
    `${saved.id}.md`,
  );
  await rm(path);
  db.update(knowledgeMemories)
    .set({ pendingContent: "# Original\n\nRecovered\n" })
    .where(eq(knowledgeMemories.id, saved.id))
    .run();
  await assert.rejects(
    knowledge.readKnowledge(a.userId, a.agentId, {
      sourceId: "memories",
      path: `${saved.id}.md`,
    }),
    { status: 404 },
  );
  await knowledge.saveMemory(a.userId, a.agentId, {
    title: "Next",
    content: "Two",
  });
  assert.match(await readFile(path, "utf8"), /Recovered/);
});

test("an unavailable runner produces an actionable error without a host qmd fallback", async () => {
  const a = await fixture();
  await assert.rejects(
    knowledge.searchKnowledge(a.userId, a.agentId, { query: "budget" }),
    { status: 503 },
  );
  await knowledge.refreshKnowledge(a.userId, a.agentId, false);
  await knowledge.waitKnowledgeJob(a.agentId);
  assert.equal(
    (await knowledge.knowledgeOverview(a.userId, a.agentId)).status.state,
    "error",
  );
});
