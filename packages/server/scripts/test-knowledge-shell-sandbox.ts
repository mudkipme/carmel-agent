/** Real offline shell qmd with isolated indexes and shared read-only model mounts. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = await mkdtemp(join(tmpdir(), "carmel-qmd-shell-test-"));
process.env.CARMEL_AGENT_DATA_DIR = root;
process.env.CARMEL_HOST_DATA_DIR = "";
process.env.CARMEL_CONTAINERIZED = "0";
process.env.DATABASE_URL = ":memory:";
process.env.CARMEL_BASH_GPU = process.env.CARMEL_TEST_GPU ?? "";
process.env.CARMEL_BASH_MEMORY_MB = "4096";
process.env.CARMEL_KNOWLEDGE_EMBED_MODEL = process.env.CARMEL_TEST_EMBED_MODEL ?? "";
const { db, initialize } = await import("../src/db/index.ts");
const { agents, knowledgeConfigs } = await import("../src/db/schema.ts");
const { createSession } = await import("../src/test-support.ts");
const { execSandboxCommand } = await import("../src/runtime/sandbox/bash-operations.ts");
const { discardAgentContainer, shutdownContainerManager } = await import("../src/runtime/sandbox/container-manager.ts");
const { knowledgeModelPlan } = await import("../src/runtime/knowledge/models.ts");
initialize();
const fixture = createSession();
const workspace = join(root, "workspace");
const backend = process.env.CARMEL_TEST_GPU ? "vulkan" : "cpu";
await mkdir(workspace);
db.update(agents).set({ workingDir: workspace, permissions: { read: true, write: true, edit: true, bash: true, network: false } })
  .where(eq(agents.id, fixture.agentId)).run();
db.insert(knowledgeConfigs).values({
  agentId: fixture.agentId, settings: { enabled: false, acceleration: backend },
  status: { state: "disabled", lastUpdatedAt: null, documents: 0, needsEmbedding: 0, error: null, backend: null, devices: [] },
}).run();
const agent = db.select().from(agents).where(eq(agents.id, fixture.agentId)).get()!;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function run(command: string, env?: Record<string, string>) {
  let stdout = "", stderr = "";
  const result = await execSandboxCommand(agent, command, workspace, {
    env, timeout: 180, signal: AbortSignal.timeout(190_000),
    onStdout: chunk => { stdout += chunk; }, onStderr: chunk => { stderr += chunk; },
  });
  assert.equal(result.exitCode, 0, stderr || stdout);
  return stdout;
}
try {
  const plan = await knowledgeModelPlan();
  await writeFile(join(plan.modelCacheDir, "shared-marker"), "shared weights directory");
  const probe = `
    const fs = require('node:fs');
    (async () => {
      const llm = await import('/usr/local/lib/node_modules/@tobilu/qmd/dist/llm.js');
      const cache = llm.DEFAULT_MODEL_CACHE_DIR;
      const before = fs.readFileSync(cache + '/shared-marker', 'utf8');
      let readonly = false;
      try { fs.writeFileSync(cache + '/shell-write', 'must fail'); } catch (error) { readonly = error.code === 'EROFS' || error.code === 'EACCES'; }
      console.log(JSON.stringify({ model: llm.resolveEmbedModel(), cache, before, readonly, gpu: process.env.QMD_LLAMA_GPU }));
    })();`;
  const state = JSON.parse(await run(`node -e ${quote(probe)}`));
  assert.equal(state.model, plan.model?.containerPath ?? plan.embeddingModel);
  assert.equal(state.gpu, backend === "cpu" ? "false" : backend);
  assert.equal(state.cache, "/home/agent/.cache/qmd/models");
  assert.equal(state.before, "shared weights directory");
  assert.equal(state.readonly, true);
  await writeFile(join(workspace, "notes.md"), "# Shell notes\nThe marmalade committee meets on Sunday.\n");
  await run("qmd collection add . --name shell-notes --mask '*.md'");
  const hits = JSON.parse(await run("qmd search marmalade --json"));
  assert.equal(hits.length, 1);
  assert.match(JSON.stringify(hits), /notes\.md/);
  // Explicit custom cache locations remain available without moving the first index.
  const custom = JSON.parse(await run(`node -e ${quote(probe.replace("const before = fs.readFileSync(cache + '/shared-marker', 'utf8');", "const before = null;"))}`, { XDG_CACHE_HOME: "/tmp/custom-cache" }));
  assert.equal(custom.cache, "/tmp/custom-cache/qmd/models");
  if (process.env.CARMEL_TEST_EMBED_MODEL) {
    await run("qmd embed");
    const status = await run("qmd status");
    assert.match(status, /1 embedded/);
    assert.ok(status.includes(plan.model!.containerPath));
  }
  console.log(`Shell qmd defaults, read-only shared cache, independent index, and overrides passed${process.env.CARMEL_TEST_EMBED_MODEL ? `, including embeddings with ${backend} configured` : ""}.`);
} finally {
  await discardAgentContainer(agent.id);
  await shutdownContainerManager();
  await rm(root, { recursive: true, force: true });
}
