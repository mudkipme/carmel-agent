import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await env.cleanup();
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
    await env.cleanup();
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
    defaultModelRefId: "model_1",
    defaultThinkingLevel: "off",
    createdAt: 0,
    updatedAt: 0,
  };
}
