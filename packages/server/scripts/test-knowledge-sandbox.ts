import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

// Isolated corpus and worker. Never starts schedulers or reads deployed agent metadata.
const root = await mkdtemp(join(tmpdir(), "carmel-knowledge-test-"));
process.env.CARMEL_AGENT_DATA_DIR = root;
process.env.DATABASE_URL = ":memory:";
process.env.CARMEL_HOST_DATA_DIR = "";
process.env.CARMEL_CONTAINERIZED = "0";
process.env.CARMEL_KNOWLEDGE_EMBED_MODEL =
  process.env.CARMEL_TEST_EMBED_MODEL ?? "";
process.env.CARMEL_KNOWLEDGE_GPU = process.env.CARMEL_TEST_GPU ?? "";
const { callKnowledgeWorker, stopKnowledgeWorker } =
  await import("../src/runtime/knowledge/worker-client.ts");
const { knowledgeModelPlan } =
  await import("../src/runtime/knowledge/models.ts");
const agentId = `test-${randomUUID()}`;
const stateDir = join(root, "state"),
  sourceDir = join(root, "source");
await Promise.all(
  [
    sourceDir,
    ...["home", "cache", "config", "notes"].map((p) => join(stateDir, p)),
  ].map((p) => mkdir(p, { recursive: true })),
);
await writeFile(
  join(sourceDir, "household.md"),
  "# Household decisions\n\nThe family holds a budget meeting on Sunday.\n",
);
const model = process.env.CARMEL_TEST_EMBED_MODEL;
const acceleration = model && process.env.CARMEL_TEST_GPU ? "vulkan" : "cpu";
const plan = {
  agentId,
  stateDir,
  ...(await knowledgeModelPlan()),
  sources: [
    { id: "family", hostPath: sourceDir, description: "Family decisions" },
  ],
  network: false,
  settings: {
    enabled: true,
    acceleration,
  },
};
try {
  const status = (await callKnowledgeWorker(plan, { op: "update" })) as {
    documents: number;
  };
  assert.equal(status.documents, 1);
  const result = (await callKnowledgeWorker(plan, {
    op: "search",
    mode: "fast",
    query: "budget",
    collections: ["family"],
    limit: 5,
  })) as { hits: Array<{ sourceId: string; path: string }> };
  assert.equal(result.hits[0]?.sourceId, "family");
  assert.equal(result.hits[0]?.path, "household.md");
  if (model) {
    const embedded = (await callKnowledgeWorker(plan, { op: "embed" })) as {
      backend: string;
      needsEmbedding: number;
      devices: string[];
    };
    assert.equal(embedded.backend, acceleration);
    assert.equal(embedded.needsEmbedding, 0);
    const semantic = (await callKnowledgeWorker(plan, {
      op: "search",
      mode: "semantic",
      query: "When do we discuss our finances?",
      collections: ["family"],
      limit: 5,
    })) as { hits: unknown[] };
    assert.ok(semantic.hits.length);
    console.log(
      "Embeddings and semantic recall passed:",
      embedded.backend,
      embedded.devices.join(", "),
    );
    // Pre-provision weights once, then prove a different offline runner can
    // embed from the shared read-only cache without its own model-file mount.
    await copyFile(model, join(plan.modelCacheDir, basename(model)));
    await stopKnowledgeWorker(agentId);
    const secondState = join(root, "second-state");
    await Promise.all(
      ["home", "cache", "config"].map((p) =>
        mkdir(join(secondState, p), { recursive: true }),
      ),
    );
    const second = {
      ...plan,
      agentId: `${agentId}-second`,
      stateDir: secondState,
      model: undefined,
      embeddingModel: `/models/cache/${basename(model)}`,
    };
    try {
      await callKnowledgeWorker(second, { op: "update" });
      const reused = (await callKnowledgeWorker(second, { op: "embed" })) as {
        needsEmbedding: number;
      };
      assert.equal(reused.needsEmbedding, 0);
      console.log(
        "A second offline agent reused the shared model cache successfully.",
      );
    } finally {
      await stopKnowledgeWorker(second.agentId);
    }
  }
  await stopKnowledgeWorker(agentId);
  const restarted = (await callKnowledgeWorker(plan, {
    op: "search",
    mode: "fast",
    query: "budget",
    collections: ["family"],
    limit: 5,
  })) as { hits: unknown[] };
  assert.equal(restarted.hits.length, 1);
  await rm(join(sourceDir, "household.md"));
  await callKnowledgeWorker(plan, { op: "update" });
  const removed = (await callKnowledgeWorker(plan, {
    op: "search",
    mode: "fast",
    query: "budget",
    collections: ["family"],
    limit: 5,
  })) as { hits: unknown[] };
  assert.equal(removed.hits.length, 0);
  console.log(
    "Runner-only indexing, lexical search, persistence, and deletion passed.",
  );
  await stopKnowledgeWorker(agentId);

  process.env.CARMEL_KNOWLEDGE_EMBED_MODEL = "";

  // Exercise Carmel's authorization and stale-hit filtering against the real index.
  const { eq } = await import("drizzle-orm");
  const { db, initialize } = await import("../src/db/index.ts");
  const { agents } = await import("../src/db/schema.ts");
  const { createSession, createUser } = await import("../src/test-support.ts");
  const service = await import("../src/services/knowledge.ts");
  initialize();
  const fixture = createSession(),
    member = createUser();
  try {
    db.update(agents)
      .set({
        shared: true,
        workingDir: sourceDir,
        permissions: {
          read: true,
          write: true,
          edit: true,
          bash: false,
          network: false,
        },
      })
      .where(eq(agents.id, fixture.agentId))
      .run();
    await service.saveKnowledgeSettings(fixture.userId, fixture.agentId, {
      enabled: true,
      acceleration: "cpu",
    });
    await writeFile(
      join(sourceDir, "household.md"),
      "# Family budget\nThe meeting is Sunday.\n",
    );
    await service.addKnowledgeSource(fixture.userId, fixture.agentId, {
      name: "Family",
      path: sourceDir,
    });
    const memory = await service.saveMemory(member, fixture.agentId, {
      title: "Shared decision",
      content: "We have a vacation budget.",
    });
    await service.refreshKnowledge(fixture.userId, fixture.agentId, false);
    await service.waitKnowledgeJob(fixture.agentId);
    const matches = await service.searchKnowledge(member, fixture.agentId, {
      query: "budget",
    });
    assert.equal(matches.hits.length, 2);
    assert.ok(
      matches.hits.every((hit) =>
        hit.citation.startsWith(`/agents/${fixture.agentId}/knowledge?`),
      ),
    );
    await writeFile(
      join(sourceDir, "household.md"),
      "# Family schedule\nUpdated content.\n",
    );
    const stale = await service.searchKnowledge(member, fixture.agentId, {
      query: "budget",
    });
    assert.equal(stale.hits.length, 1);
    assert.equal(stale.hits[0]?.sourceId, "memories");
    assert.match(stale.warning ?? "", /changed/);
    // Offline semantic fallback must not wait for a download that cannot succeed.
    const fallback = await service.searchKnowledge(member, fixture.agentId, {
      query: "budget",
      mode: "semantic",
    });
    assert.equal(fallback.mode, "fast");
    assert.match(fallback.warning ?? "", /not cached/);
    await service.forgetMemory(
      fixture.userId,
      fixture.agentId,
      memory.id,
      memory.revision,
    );
    assert.equal(
      (
        await service.searchKnowledge(member, fixture.agentId, {
          query: "budget",
        })
      ).hits.length,
      0,
    );
    console.log(
      "Shared retrieval, citations, stale-hit rejection, offline fallback, and forgetting passed.",
    );
  } finally {
    await service.deleteAgentKnowledge(fixture.agentId);
  }
} finally {
  await stopKnowledgeWorker(agentId);
  await rm(root, { recursive: true, force: true });
}
