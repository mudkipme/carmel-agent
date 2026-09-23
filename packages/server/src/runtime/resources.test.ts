import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { TEST_CONTEXT } from "../effectors/testing/pi-harness.ts";
import type { agents } from "../db/schema.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import { loadAgentResources } from "./resources.ts";

type AgentRecord = typeof agents.$inferSelect;

test("filesystem resources load through AgentExecutionEnv with Pi-native parsing", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-resources-"));
  mkdirSync(join(workingDir, ".agents", "skills", "review"), { recursive: true });
  mkdirSync(join(workingDir, ".pi", "prompts"), { recursive: true });
  writeFileSync(
    join(workingDir, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code carefully\n---\nUse the checklist.",
  );
  writeFileSync(
    join(workingDir, ".pi", "prompts", "summarize.md"),
    "---\ndescription: Summarize this\n---\nSummarize $ARGUMENTS",
  );
  writeFileSync(join(workingDir, "AGENTS.md"), "Project instructions");
  const env = new AgentExecutionEnv(makeAgent(workingDir));

  try {
    const resources = await loadAgentResources(env.agent, env);
    assert.deepEqual(resources.skills.map(({ name, description, content }) => ({ name, description, content })), [
      { name: "review", description: "Review code carefully", content: "Use the checklist." },
    ]);
    assert.deepEqual(resources.promptTemplates, [
      { name: "summarize", description: "Summarize this", content: "Summarize $ARGUMENTS" },
    ]);
    assert.equal(resources.contextFiles[0]?.content, "Project instructions");
  } finally {
    await env.cleanup(TEST_CONTEXT);
  }
});

test("resource discovery cannot follow a skill symlink outside readable roots", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-resources-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "carmel-agent-outside-"));
  mkdirSync(join(workingDir, ".agents", "skills"), { recursive: true });
  writeFileSync(join(outsideDir, "SKILL.md"), "---\nname: escape\ndescription: Secret\n---\nsecret");
  symlinkSync(outsideDir, join(workingDir, ".agents", "skills", "escape"));
  const env = new AgentExecutionEnv(makeAgent(workingDir));

  try {
    const resources = await loadAgentResources(env.agent, env);
    assert.deepEqual(resources.skills, []);
    assert.ok(resources.diagnostics.some((diagnostic) => /outside the agent working directory/.test(diagnostic.message)));
  } finally {
    await env.cleanup(TEST_CONTEXT);
  }
});

test("Pi's text line reader preserves line endings and respects agent read roots", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-reader-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "carmel-agent-outside-"));
  writeFileSync(join(workingDir, "session.jsonl"), "complete\npartial");
  writeFileSync(join(outsideDir, "secret.jsonl"), "secret\n");
  symlinkSync(join(outsideDir, "secret.jsonl"), join(workingDir, "escape.jsonl"));
  const env = new AgentExecutionEnv(makeAgent(workingDir));

  try {
    const opened = await env.openTextLineReader("session.jsonl", TEST_CONTEXT);
    if (!opened.ok) assert.fail(opened.error.message);
    try {
      assert.deepEqual(await opened.value.readLine(TEST_CONTEXT), { ok: true, value: { text: "complete", terminated: true } });
      assert.deepEqual(await opened.value.readLine(TEST_CONTEXT), { ok: true, value: { text: "partial", terminated: false } });
      assert.deepEqual(await opened.value.readLine(TEST_CONTEXT), { ok: true, value: undefined });
    } finally {
      await opened.value.close(TEST_CONTEXT);
    }

    for (const path of [relative(workingDir, join(outsideDir, "secret.jsonl")), "escape.jsonl"]) {
      const denied = await env.openTextLineReader(path, TEST_CONTEXT);
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.error.code, "permission_denied");
    }
  } finally {
    await env.cleanup(TEST_CONTEXT);
  }
});

function makeAgent(workingDir: string): AgentRecord {
  return {
    id: "agent_resources",
    ownerUserId: "user_1",
    shared: false,
    name: "Agent",
    description: "",
    workingDirMode: "manual",
    workingDir,
    defaultWorkingDir: null,
    mounts: [],
    systemPrompt: "",
    promptTemplates: [],
    permissions: { read: true, write: false, edit: false, bash: false, network: false },
    enabledExtensions: [],
    defaultModelRefId: "model_1",
    defaultThinkingLevel: "off",
    createdAt: 0,
    updatedAt: 0,
  };
}

test("skills and prompt templates reach the system prompt in a stable order", async () => {
  // Pi discovers both with `readdirSync` and no ordering of its own. An order
  // that shifts between runs silently invalidates the cached prompt prefix for
  // the whole session, which is far more expensive than sorting.
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-resources-"));
  for (const name of ["zebra", "alpha", "middle"]) {
    mkdirSync(join(workingDir, ".agents", "skills", name), { recursive: true });
    writeFileSync(
      join(workingDir, ".agents", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} skill\n---\nBody.`,
    );
  }
  const env = new AgentExecutionEnv(makeAgent(workingDir));

  try {
    const resources = await loadAgentResources(env.agent, env);
    assert.deepEqual(resources.skills.map((skill) => skill.name), ["alpha", "middle", "zebra"]);
  } finally {
    await env.cleanup(TEST_CONTEXT);
  }
});

test("PI_CACHE_RETENTION defaults to the 1-hour cache", () => {
  // The default that keeps a session's prefix cached across an ordinary human
  // pause instead of the 5 minutes Pi ships with.
  assert.equal(process.env.PI_CACHE_RETENTION, "long");
});
