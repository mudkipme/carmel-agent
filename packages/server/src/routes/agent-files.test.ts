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

  const app = createTestApp(
    makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), read: true } }),
  );
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
  assert.deepEqual(await createResponse.json(), {
    error: "Write permission is disabled for this agent.",
  });
});

test("file routes do not create files outside the working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "escaped.txt");
  await mkdir(workspace);

  const app = createTestApp(
    makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), write: true } }),
  );
  const response = await app.request("/agent_1/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "../escaped.txt", type: "file" }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /outside the agent working directory/);
  assert.equal(existsSync(outside), false);
});

test("write-only file routes can create and rename inside the workspace", async () => {
  const agent = makeAgent({
    workingDirMode: "default",
    permissions: { ...allPermissions(false), write: true },
  });
  const app = createTestApp(agent);

  const createResponse = await app.request("/agent_1/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "created.txt", type: "file" }),
  });
  assert.equal(createResponse.status, 201);
  assert.equal(existsSync(join(agent.workingDir, "created.txt")), true);

  const renameResponse = await app.request("/agent_1/files", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "created.txt", newPath: "renamed.txt" }),
  });
  assert.equal(renameResponse.status, 200);
  assert.equal(existsSync(join(agent.workingDir, "created.txt")), false);
  assert.equal(existsSync(join(agent.workingDir, "renamed.txt")), true);
});

test("file routes reject reads through symlinks outside the working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  await mkdir(workspace);
  await writeFile(outside, "outside");
  await symlink(outside, join(workspace, "linked.txt"));

  const app = createTestApp(
    makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), read: true } }),
  );
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

  const app = createTestApp(
    makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), edit: true } }),
  );
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

  const app = createTestApp(
    makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), write: true } }),
  );
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

  const app = createTestApp(
    makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), read: true } }),
  );
  const response = await app.request("/agent_1/files");

  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).entries.map((entry: { name: string }) => entry.name),
    ["inside.txt"],
  );
});

test("file routes reject deleting the working directory root", async () => {
  const agent = makeAgent({
    workingDirMode: "default",
    permissions: { ...allPermissions(false), write: true },
  });
  const app = createTestApp(agent);

  const response = await app.request("/agent_1/files?path=", { method: "DELETE" });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "The working directory cannot be deleted." });
  assert.equal(existsSync(agent.workingDir), true);
});

test("file routes stream a single file as a download attachment", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), read: true } });
  await writeFile(join(agent.workingDir, "notes déjà.txt"), "downloaded");
  const app = createTestApp(agent);

  const response = await app.request(
    `/agent_1/files/download?path=${encodeURIComponent("notes déjà.txt")}`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /filename\*=UTF-8''notes%20d%C3%A9j%C3%A0\.txt/,
  );
  assert.equal(await response.text(), "downloaded");
});

test("file routes stream a directory selection as a zip archive", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), read: true } });
  await mkdir(join(agent.workingDir, "src"));
  await writeFile(join(agent.workingDir, "src", "index.ts"), "export {};");
  await writeFile(join(agent.workingDir, "src", ".hidden"), "kept");
  const app = createTestApp(agent);

  const response = await app.request("/agent_1/files/download?path=src");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition") ?? "", /filename="src\.zip"/);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(archive.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
  // Hidden files travel with the folder: a download is a copy, not a listing.
  for (const name of ["src/", "src/index.ts", "src/.hidden"]) {
    assert.ok(archive.includes(Buffer.from(name)), `archive is missing ${name}`);
  }
});

test("file routes refuse to download outside the working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "outside.txt"), "outside");

  const app = createTestApp(
    makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), read: true } }),
  );
  const response = await app.request("/agent_1/files/download?path=../outside.txt");

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /outside the agent working directory/);
});

test("uploads create nested files and refuse to clobber without overwrite", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), write: true } });
  const app = createTestApp(agent);

  const created = await app.request("/agent_1/files/upload?path=assets/logo.txt", {
    method: "PUT",
    body: "first",
  });
  assert.equal(created.status, 201);
  const entry = await created.json();
  assert.deepEqual(entry, {
    name: "logo.txt",
    path: "assets/logo.txt",
    type: "file",
    size: 5,
    updatedAt: entry.updatedAt,
    hidden: false,
  });
  assert.equal(await readFile(join(agent.workingDir, "assets", "logo.txt"), "utf-8"), "first");

  const conflict = await app.request("/agent_1/files/upload?path=assets/logo.txt", {
    method: "PUT",
    body: "second",
  });
  assert.equal(conflict.status, 409);
  assert.equal(await readFile(join(agent.workingDir, "assets", "logo.txt"), "utf-8"), "first");

  const replaced = await app.request("/agent_1/files/upload?path=assets/logo.txt&overwrite=true", {
    method: "PUT",
    body: "second",
  });
  assert.equal(replaced.status, 201);
  assert.equal(await readFile(join(agent.workingDir, "assets", "logo.txt"), "utf-8"), "second");
});

test("uploads stay inside the working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "carmel-agent-files-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  const app = createTestApp(
    makeAgent({ workingDir: workspace, permissions: { ...allPermissions(false), write: true } }),
  );
  const response = await app.request("/agent_1/files/upload?path=../escaped.txt", {
    method: "PUT",
    body: "nope",
  });

  assert.equal(response.status, 400);
  assert.equal(existsSync(join(root, "escaped.txt")), false);
});

test("batch delete reports each path it could not remove", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), write: true } });
  await mkdir(join(agent.workingDir, "logs"));
  await writeFile(join(agent.workingDir, "logs", "run.log"), "log");
  await writeFile(join(agent.workingDir, "keep.txt"), "keep");
  const app = createTestApp(agent);

  const response = await app.request("/agent_1/files/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "delete", paths: ["logs", "missing.txt"] }),
  });

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.completed, ["logs"]);
  assert.deepEqual(
    result.failed.map((failure: { path: string }) => failure.path),
    ["missing.txt"],
  );
  assert.equal(existsSync(join(agent.workingDir, "logs")), false);
  assert.equal(existsSync(join(agent.workingDir, "keep.txt")), true);
});

test("batch move and copy place entries in the destination directory", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), write: true } });
  await mkdir(join(agent.workingDir, "target"));
  await writeFile(join(agent.workingDir, "moved.txt"), "moved");
  await writeFile(join(agent.workingDir, "copied.txt"), "copied");
  const app = createTestApp(agent);

  const moved = await app.request("/agent_1/files/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "move", paths: ["moved.txt"], destination: "target" }),
  });
  assert.deepEqual((await moved.json()).completed, ["moved.txt"]);
  assert.equal(existsSync(join(agent.workingDir, "moved.txt")), false);
  assert.equal(await readFile(join(agent.workingDir, "target", "moved.txt"), "utf-8"), "moved");

  const copied = await app.request("/agent_1/files/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "copy", paths: ["copied.txt"], destination: "target" }),
  });
  assert.deepEqual((await copied.json()).completed, ["copied.txt"]);
  assert.equal(await readFile(join(agent.workingDir, "copied.txt"), "utf-8"), "copied");
  assert.equal(await readFile(join(agent.workingDir, "target", "copied.txt"), "utf-8"), "copied");
});

test("batch move refuses to place a directory inside itself", async () => {
  const agent = makeAgent({ permissions: { ...allPermissions(false), write: true } });
  await mkdir(join(agent.workingDir, "project", "nested"), { recursive: true });
  const app = createTestApp(agent);

  const response = await app.request("/agent_1/files/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "move", paths: ["project"], destination: "project/nested" }),
  });

  const result = await response.json();
  assert.deepEqual(result.completed, []);
  assert.match(result.failed[0].error, /cannot be placed inside itself/);
  assert.equal(existsSync(join(agent.workingDir, "project", "nested")), true);
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
      role: "admin",
      fastTaskModelRefId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    await next();
  });
  app.route(
    "/",
    createAgentFilesRoute((userId, agentId) =>
      userId === "user_1" && agentId === agent.id ? agent : undefined,
    ),
  );
  return app;
}

function makeAgent(
  overrides: Partial<AgentRecord> & { permissions?: AgentRecord["permissions"] },
): AgentRecord {
  return {
    id: "agent_1",
    ownerUserId: "user_1",
    shared: false,
    name: "Agent",
    description: "",
    mcpServers: [],
    codemodeEnabled: false,
    workingDirMode: "manual",
    workingDir: mkdtempSync(join(tmpdir(), "carmel-agent-files-test-")),
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
