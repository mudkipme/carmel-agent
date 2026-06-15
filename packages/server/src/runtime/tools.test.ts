import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerToolDefinitions } from "./tools.ts";
import type { agents } from "../db/schema.ts";

type AgentRecord = typeof agents.$inferSelect;

test("createServerToolDefinitions exposes no tools when every runtime permission is disabled", () => {
  const tools = createServerToolDefinitions(makeAgent({}));

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [],
  );
});

test("createServerToolDefinitions maps server runtime permissions to their tool surface", () => {
  const tools = createServerToolDefinitions(
    makeAgent({
      permissions: {
        read: true,
        write: true,
        edit: true,
        bash: true,
        network: true,
      },
    }),
  );

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["bash", "edit", "exa_search", "fetch_url", "find", "grep", "ls", "read", "write"],
  );
});

test("read tools reject paths outside the readable runtime roots", () => {
  const tools = createServerToolDefinitions(makeAgent({ permissions: { ...allPermissions(false), read: true } }));
  const readTool = tools.find((tool) => tool.name === "read");

  assert.ok(readTool);
  assert.throws(
    () =>
      executeTool(
        readTool,
        "call_1",
        { path: "../outside.txt" },
        new AbortController().signal,
      ),
    /outside the agent working directory/,
  );
});

test("write tools reject paths outside the writable runtime root", () => {
  const tools = createServerToolDefinitions(makeAgent({ permissions: { ...allPermissions(false), write: true } }));
  const writeTool = tools.find((tool) => tool.name === "write");

  assert.ok(writeTool);
  assert.throws(
    () =>
      executeTool(
        writeTool,
        "call_1",
        { path: "../outside.txt", content: "should not be written" },
        new AbortController().signal,
      ),
    /outside the agent working directory/,
  );
});

function executeTool(tool: { execute: unknown }, toolCallId: string, params: Record<string, unknown>, signal: AbortSignal) {
  return (tool.execute as (...args: unknown[]) => unknown)(toolCallId, params, signal, undefined, undefined);
}

function makeAgent(overrides: Partial<AgentRecord> & { permissions?: AgentRecord["permissions"] }): AgentRecord {
  return {
    id: "agent_1",
    ownerUserId: "user_1",
    shared: false,
    name: "Agent",
    description: "",
    workingDirMode: "manual",
    workingDir: mkdtempSync(join(tmpdir(), "carmel-agent-runtime-test-")),
    defaultWorkingDir: null,
    mounts: [],
    systemPrompt: "",
    promptTemplates: [],
    permissions: allPermissions(false),
    defaultModelRefId: "model_1",
    defaultThinkingLevel: "off",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function allPermissions(value: boolean): AgentRecord["permissions"] {
  return {
    read: value,
    write: value,
    edit: value,
    bash: value,
    network: value,
  };
}
