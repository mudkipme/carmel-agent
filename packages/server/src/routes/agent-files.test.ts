import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAgentFilesRoute } from "./agent-files.ts";
import type { AuthVariables } from "../auth.ts";
import type { agents } from "../db/schema.ts";

type AgentRecord = typeof agents.$inferSelect;

test("file routes reject reads when read permission is disabled", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), write: true } });
  writeFileSync(join(agent.workingDir, "note.txt"), "secret");
  const app = createTestApp(agent);

  const response = await app.request("/agent_1/files");

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Read permission is disabled for this agent." });
});

test("file routes reject path traversal outside the working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "outside");

  const app = createTestApp(makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), read: true } }));
  const response = await app.request("/agent_1/files/content?path=../outside.txt");

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /outside the agent working directory/);
});

test("file routes allow edit-only content updates but still reject file creation", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), edit: true } });
  const app = createTestApp(agent);
  const target = join(agent.workingDir, "note.txt");
  await writeFile(target, "before");

  const updateResponse = await app.request("/agent_1/files/content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "note.txt", content: "after" }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal(await readFile(target, "utf-8"), "after");

  const createResponse = await app.request("/agent_1/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "new.txt", type: "file" }),
  });
  assert.equal(createResponse.status, 403);
  assert.deepEqual(await createResponse.json(), { error: "Write permission is disabled for this agent." });
});

test("file routes do not create files outside the working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "escaped.txt");
  await mkdir(workspace);

  const app = createTestApp(makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), write: true } }));
  const response = await app.request("/agent_1/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "../escaped.txt", type: "file" }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /outside the agent working directory/);
  assert.equal(existsSync(outside), false);
});

test("file routes reject reads through symlinks outside the working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "outside");
  await symlink(outside, join(workspace, "linked.txt"));

  const app = createTestApp(makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), read: true } }));
  const response = await app.request("/agent_1/files/content?path=linked.txt");

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /outside the agent working directory/);
});

test("file routes reject writes through symlinks outside the working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "outside");
  await symlink(outside, join(workspace, "linked.txt"));

  const app = createTestApp(makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), edit: true } }));
  const response = await app.request("/agent_1/files/content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "linked.txt", content: "changed" }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /outside the agent working directory/);
  assert.equal(await readFile(outside, "utf-8"), "outside");
});

test("file routes reject creating through broken symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await symlink(outside, join(workspace, "linked.txt"));

  const app = createTestApp(makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), write: true } }));
  const response = await app.request("/agent_1/files/content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "linked.txt", content: "changed" }),
  });

  assert.equal(response.status, 404);
  assert.equal(existsSync(outside), false);
});

test("file routes omit symlinks outside the working directory from listings", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(join(workspace, "inside.txt"), "inside");
  await writeFile(outside, "outside");
  await symlink(outside, join(workspace, "linked.txt"));

  const app = createTestApp(makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), read: true } }));
  const response = await app.request("/agent_1/files");

  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).entries.map((entry: { name: string }) => entry.name),
    ["inside.txt"],
  );
});

test("file routes reject deleting the working directory root", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), write: true } });
  const app = createTestApp(agent);

  const response = await app.request("/agent_1/files?path=", { method: "DELETE" });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "The working directory cannot be deleted." });
  assert.equal(existsSync(agent.workingDir), true);
});

function createTestApp(agent: AgentRecord) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user_1",
      username: "user",
      passwordHash: null,
      name: "User",
      email: "user@example.com",
      fastTaskModelRefId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    await next();
  });
  app.route("/", createAgentFilesRoute((userId, agentId) => (userId === "user_1" && agentId === agent.id ? agent : undefined)));
  return app;
}

function makeAgent(overrides: Partial<AgentRecord> & { permissions?: AgentRecord["permissions"] }): AgentRecord {
  return {
    id: "agent_1",
    ownerUserId: "user_1",
    shared: false,
    name: "Agent",
    description: "",
    workingDirMode: "manual",
    workingDir: mkdtempSync(join(tmpdir(), "carmel-agent-files-test-")),
    defaultWorkingDir: null,
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
