import { executeNativeTool } from "../effectors/testing/tools.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrThrow, withAbortSignal } from "../effectors/pi-durable/index.ts";
import { TEST_CONTEXT } from "../effectors/testing/pi-harness.ts";
import { createGrepOperations } from "./search-operations.ts";
import { createServerExecution, createServerToolDefinitions, remapContainerPath } from "./tools.ts";
import { loadBuiltinSkills } from "./builtin-skills.ts";
import { formatSkillInvocation } from "../effectors/pi-durable/index.ts";
import type { agents } from "../db/schema.ts";
import { initialize } from "../db/index.ts";

type AgentRecord = typeof agents.$inferSelect;
initialize();

test("Durable reads images through the guarded environment", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-image-read-"));
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";
  writeFileSync(join(workingDir, "pixel.png"), Buffer.from(png, "base64"));
  const execution = createServerExecution(
    makeAgent({ workingDir, permissions: { ...allPermissions(false), read: true } }),
  );
  try {
    const tool = execution.tools.find((tool) => tool.name === "read")!;
    const result = (await executeTool(
      tool,
      "image",
      { path: "pixel.png" },
      new AbortController().signal,
      execution.env,
    )) as { output: Array<{ type: string; mimeType?: string }> };
    assert.ok(
      result.output.some((part) => part.type === "image" && part.mimeType === "image/png"),
      JSON.stringify(result),
    );
    await assert.rejects(
      executeTool(
        tool,
        "outside",
        { path: "../outside.png" },
        new AbortController().signal,
        execution.env,
      ),
      /outside the agent working directory/,
    );
  } finally {
    await execution.cleanup(TEST_CONTEXT);
    rmSync(workingDir, { recursive: true, force: true });
  }
});

test("Durable converts and resizes images through the guarded environment", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-image-resize-"));
  // A minimal 24-bit BMP wider than Pi's default 2000-pixel image limit.
  const width = 2400;
  const height = 2;
  const bitmap = Buffer.alloc(54 + width * height * 3, 255);
  bitmap.fill(0, 0, 54);
  bitmap.write("BM");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  writeFileSync(join(workingDir, "wide.bmp"), bitmap);
  const execution = createServerExecution(
    makeAgent({ workingDir, permissions: { ...allPermissions(false), read: true } }),
  );
  try {
    const result = (await executeTool(
      execution.tools.find((tool) => tool.name === "read")!,
      "image",
      { path: "wide.bmp" },
      new AbortController().signal,
      execution.env,
    )) as { output: Array<{ type: string; mimeType?: string }> };
    assert.ok(result.output.some((part) => part.type === "image" && part.mimeType === "image/png"));
    assert.match(JSON.stringify(result), /Converted from image\/bmp to image\/png/);
    assert.match(JSON.stringify(result), /Resized from 2400x2 to 2000x2/);
  } finally {
    await execution.cleanup(TEST_CONTEXT);
    rmSync(workingDir, { recursive: true, force: true });
  }
});

test("remapContainerPath translates container paths to host paths", () => {
  const mappings = [
    { containerPath: "/workspace", hostPath: "/data/agents/a/workspace" },
    { containerPath: "/tmp", hostPath: "/data/agents/a/tmp" },
    { containerPath: "/home/agent", hostPath: "/data/agents/a/home" },
    { containerPath: "/refs", hostPath: "/srv/shared" },
  ];
  // workspace + /tmp + $HOME + an extra mount whose target differs from its host source
  assert.equal(
    remapContainerPath("/workspace/src/x.ts", mappings),
    "/data/agents/a/workspace/src/x.ts",
  );
  assert.equal(remapContainerPath("/tmp/out.txt", mappings), "/data/agents/a/tmp/out.txt");
  assert.equal(remapContainerPath("/home/agent/.npmrc", mappings), "/data/agents/a/home/.npmrc");
  assert.equal(remapContainerPath("/refs/readme.md", mappings), "/srv/shared/readme.md");
  // relative paths and unmapped absolute paths pass through unchanged
  assert.equal(remapContainerPath("notes/todo.md", mappings), "notes/todo.md");
  assert.equal(remapContainerPath("/etc/passwd", mappings), "/etc/passwd");
  assert.equal(
    remapContainerPath("/workspace-other/file.txt", mappings),
    "/workspace-other/file.txt",
  );
});

test("server filesystem tools accept runner paths across workspace, tmp, home, and mounts", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-container-paths-"));
  const references = mkdtempSync(join(tmpdir(), "carmel-container-refs-"));
  const execution = createServerExecution(
    makeAgent({
      id: `agent_paths_${crypto.randomUUID()}`,
      workingDir,
      workingDirMode: "default",
      mounts: [{ source: references, target: "/refs", readOnly: true }],
      permissions: { ...allPermissions(true), bash: false, network: false },
    }),
  );
  const { env } = execution;
  const call = (name: string, args: Record<string, unknown>) =>
    executeTool(
      execution.tools.find((tool) => tool.name === name)!,
      name,
      args,
      new AbortController().signal,
      execution.env,
    );
  try {
    assert.equal(env.cwd, "/workspace");
    assert.equal(env.hostCwd, workingDir);
    for (const [root, storage] of [
      ["/workspace", workingDir],
      ["/tmp", env.tmpDir],
      ["/home/agent", env.homeDir],
      ["/refs", references],
    ]) {
      mkdirSync(join(storage!, "src"), { recursive: true });
      // Actual file contents must never be rewritten just because they contain storage paths.
      const content = `needle ${workingDir}\nsecond line\n`;
      writeFileSync(join(storage!, "src", "notes.txt"), content);
      assert.equal(readToolText(await call("read", { path: `${root}/src/notes.txt` })), content);
      assert.match(readToolText(await call("ls", { path: `${root}/src` })), /^notes\.txt$/m);
      assert.match(
        readToolText(await call("find", { path: root, pattern: "**/*.txt" })),
        /^src\/notes\.txt$/m,
      );
      assert.equal(
        readToolText(await call("grep", { path: `${root}/src`, pattern: "needle" })),
        `notes.txt:1: needle ${workingDir}`,
      );
      assert.match(
        readToolText(
          await call("grep", { path: `${root}/src/notes.txt`, pattern: "needle", context: 1 }),
        ),
        /second line/,
      );
      assert.equal(
        getOrThrow(await env.absolutePath(join(storage!, "src", "notes.txt"), TEST_CONTEXT)),
        `${root}/src/notes.txt`,
      );
      assert.equal(
        getOrThrow(await env.canonicalPath(`${root}/src/notes.txt`, TEST_CONTEXT)),
        `${root}/src/notes.txt`,
      );
      assert.equal(
        getOrThrow(await env.fileInfo(`${root}/src/notes.txt`, TEST_CONTEXT)).path,
        `${root}/src/notes.txt`,
      );
      assert.equal(
        getOrThrow(await env.listDir(`${root}/src`, TEST_CONTEXT))[0]?.path,
        `${root}/src/notes.txt`,
      );
    }
    assert.match(readToolText(await call("read", { path: "src/notes.txt" })), /^needle/);
    await call("write", { path: "/workspace/new.txt", content: "before" });
    await call("edit", {
      path: "/workspace/new.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });
    assert.equal(readFileSync(join(workingDir, "new.txt"), "utf8"), "after");
    await assert.rejects(
      call("write", { path: "/refs/new.txt", content: "denied" }),
      /outside the agent working directory/,
    );
    for (const name of ["read", "ls", "find", "grep", "write"]) {
      await assert.rejects(
        call(name, { path: "/workspace/../etc/passwd", pattern: "needle", content: "denied" }),
        /outside the agent working directory/,
      );
    }
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";
    writeFileSync(join(workingDir, "pixel.png"), Buffer.from(png, "base64"));
    const image = (await call("read", { path: "/workspace/pixel.png" })) as {
      output: Array<{ type: string }>;
    };
    assert.ok(image.output.some((part) => part.type === "image"));

    const manual = createServerExecution(
      makeAgent({
        id: `agent_nested_${crypto.randomUUID()}`,
        workingDir,
        workingDirMode: "manual",
        mounts: [{ source: references, target: join(workingDir, "refs"), readOnly: true }],
        permissions: { ...allPermissions(false), read: true, write: true },
      }),
    );
    try {
      const path = join(workingDir, "refs", "src", "notes.txt");
      assert.equal(manual.env.resolveAuthorizedPath(path), join(references, "src", "notes.txt"));
      assert.match(getOrThrow(await manual.env.readTextFile(path, TEST_CONTEXT)), /^needle/);
      const denied = await manual.env.writeFile(path, "denied", TEST_CONTEXT);
      assert.equal(denied.ok, false);
    } finally {
      await manual.cleanup(TEST_CONTEXT);
      for (const directory of [manual.env.tmpDir, manual.env.homeDir])
        rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    await execution.cleanup(TEST_CONTEXT);
    for (const directory of [workingDir, references, env.tmpDir, env.homeDir])
      rmSync(directory, { recursive: true, force: true });
  }
});

test("generated paths and filesystem errors use runner paths", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-container-output-"));
  const execution = createServerExecution(
    makeAgent({
      id: `agent_output_${crypto.randomUUID()}`,
      workingDir,
      workingDirMode: "default",
      permissions: { ...allPermissions(true), bash: false, network: false },
    }),
  );
  const { env } = execution;
  try {
    const file = getOrThrow(
      await env.createTempFile({ prefix: "output-", suffix: ".txt" }, TEST_CONTEXT),
    );
    assert.match(file, /^\/tmp\/output-.*\/file\.txt$/);
    getOrThrow(await env.writeFile(file, "saved output", TEST_CONTEXT));
    assert.equal(readFileSync(env.resolveAuthorizedPath(file), "utf8"), "saved output");
    assert.match(getOrThrow(await env.createTempDir("task-", TEST_CONTEXT)), /^\/tmp\/task-/);
    const reader = getOrThrow(await env.openBinaryReader(file, undefined, TEST_CONTEXT));
    assert.equal(getOrThrow(await reader.info(TEST_CONTEXT)).path, file);
    await reader.close(TEST_CONTEXT);
    const closed = await reader.read(0, 1, TEST_CONTEXT);
    assert.equal(closed.ok, false);
    if (!closed.ok) assert.equal(closed.error.path, file);
    writeFileSync(join(workingDir, "file.txt"), "data");
    const listing = getOrThrow(await env.openDirReader("/workspace", TEST_CONTEXT));
    try {
      assert.equal(
        getOrThrow(await listing.next(10, TEST_CONTEXT)).entries[0]?.path,
        "/workspace/file.txt",
      );
    } finally {
      await listing.close(TEST_CONTEXT);
    }
    const missing = await env.readTextFile("/workspace/missing.txt", TEST_CONTEXT);
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.path, "/workspace/missing.txt");
      assert.ok(missing.error.message.includes("/workspace/missing.txt"));
      assert.ok(!missing.error.message.includes(workingDir));
    }
    for (const name of ["grep", "find"]) {
      const tool = execution.tools.find((tool) => tool.name === name)!;
      await assert.rejects(
        executeTool(
          tool,
          "missing",
          { path: "/workspace/missing", pattern: "needle" },
          new AbortController().signal,
          execution.env,
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("/workspace/missing"), error.message);
          assert.ok(!error.message.includes(workingDir), error.message);
          return true;
        },
      );
    }
  } finally {
    await execution.cleanup(TEST_CONTEXT);
    for (const directory of [workingDir, env.tmpDir, env.homeDir])
      rmSync(directory, { recursive: true, force: true });
  }
});

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

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "bash",
    "edit",
    "exa_search",
    "fetch_url",
    "find",
    "grep",
    "ls",
    "read",
    "write",
  ]);
  assert.deepEqual(
    tools
      .filter((tool) => tool.replay === "safe")
      .map((tool) => tool.name)
      .sort(),
    ["find", "grep", "ls", "read"],
  );
});

test("the built-in skill loader is permission gated and returns the registered skill without file access", async () => {
  for (const codemodeEnabled of [false, true])
    for (const bash of [false, true])
      for (const network of [false, true]) {
        const agent = makeAgent({
          codemodeEnabled,
          permissions: { ...allPermissions(false), bash, network },
        });
        // Browser guides also serve authorized admin tasks on another user's private agent.
        const execution = createServerExecution(agent, undefined, "task_user");
        try {
          const tools = execution.resolveTools();
          const loader = tools.find((tool) => tool.name === "load_builtin_skill");
          assert.equal(Boolean(loader), bash && network);
          assert.equal(
            tools.some((tool) => tool.name === "read"),
            false,
          );
          if (!loader) continue;
          assert.equal(loader.replay, "safe");
          const result = await executeTool(
            loader,
            "load_browser",
            { name: "agent-browser" },
            new AbortController().signal,
            execution.env,
          );
          const [skill] = await loadBuiltinSkills(agent);
          assert.equal(readToolText(result), formatSkillInvocation(skill!));
          assert.ok(!readToolText(result).includes(skill!.filePath));
          const invalid = await executeTool(
            loader,
            "load_path",
            { name: "../../etc/passwd" },
            new AbortController().signal,
            execution.env,
          );
          assert.equal(
            (invalid as { isError: boolean }).isError,
            true,
            "native validation rejects unregistered skill names",
          );
          agent.permissions.network = false;
          await assert.rejects(
            () =>
              executeTool(
                loader,
                "load_revoked",
                { name: "agent-browser" },
                new AbortController().signal,
                execution.env,
              ),
            /unavailable/,
          );
        } finally {
          await execution.cleanup(TEST_CONTEXT);
        }
      }
});

test("read tools reject paths outside the readable runtime roots", async () => {
  const { tools, env } = createServerExecution(
    makeAgent({ permissions: { ...allPermissions(false), read: true } }),
  );
  const readTool = tools.find((tool) => tool.name === "read");

  assert.ok(readTool);
  await assert.rejects(
    () =>
      executeTool(
        readTool,
        "call_1",
        { path: "../outside.txt" },
        new AbortController().signal,
        env,
      ),
    /outside the agent working directory/,
  );
});

test("write tools reject paths outside the writable runtime root", async () => {
  const { tools, env } = createServerExecution(
    makeAgent({ permissions: { ...allPermissions(false), write: true } }),
  );
  const writeTool = tools.find((tool) => tool.name === "write");

  assert.ok(writeTool);
  await assert.rejects(
    () =>
      executeTool(
        writeTool,
        "call_1",
        { path: "../outside.txt", content: "should not be written" },
        new AbortController().signal,
        env,
      ),
    /outside the agent working directory/,
  );
});

test("read tools reject a symlink inside the workspace that points outside it", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-runtime-test-"));
  const secretDir = mkdtempSync(join(tmpdir(), "carmel-agent-secret-"));
  writeFileSync(join(secretDir, "secret.txt"), "top secret");
  // Simulate `ln -s <secret> escape` created from inside the sandbox: the link
  // lives in the workspace but resolves to a host path outside every root.
  symlinkSync(join(secretDir, "secret.txt"), join(workingDir, "escape"));

  const { tools, env } = createServerExecution(
    makeAgent({ workingDir, permissions: { ...allPermissions(false), read: true } }),
  );
  const readTool = tools.find((tool) => tool.name === "read");

  assert.ok(readTool);
  await assert.rejects(
    () => executeTool(readTool, "call_1", { path: "escape" }, new AbortController().signal, env),
    /outside the agent working directory/,
  );
});

test("write tools reject writing through a symlink that points outside the workspace", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-runtime-test-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "carmel-agent-outside-"));
  writeFileSync(join(outsideDir, "target.txt"), "original");
  symlinkSync(join(outsideDir, "target.txt"), join(workingDir, "escape"));

  const { tools, env } = createServerExecution(
    makeAgent({ workingDir, permissions: { ...allPermissions(false), write: true } }),
  );
  const writeTool = tools.find((tool) => tool.name === "write");

  assert.ok(writeTool);
  await assert.rejects(
    () =>
      executeTool(
        writeTool,
        "call_1",
        { path: "escape", content: "overwritten" },
        new AbortController().signal,
        env,
      ),
    /outside the agent working directory/,
  );
});

test("grep rejects an explicit symlink outside AgentExecutionEnv roots", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-runtime-test-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "carmel-agent-outside-"));
  writeFileSync(join(outsideDir, "secret.txt"), "top secret");
  symlinkSync(join(outsideDir, "secret.txt"), join(workingDir, "escape"));
  const { tools, env } = createServerExecution(
    makeAgent({ workingDir, permissions: { ...allPermissions(false), read: true } }),
  );
  const grepTool = tools.find((tool) => tool.name === "grep");

  assert.ok(grepTool);
  await assert.rejects(
    () =>
      executeTool(
        grepTool,
        "call_1",
        { pattern: "secret", path: "escape" },
        new AbortController().signal,
        env,
      ),
    /outside the agent working directory/,
  );
  await assert.rejects(
    async () => createGrepOperations(env).readFile(join(workingDir, "escape")),
    /outside the agent working directory/,
  );
});

test("ls omits external symlinks while preserving safe directory symlinks", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-runtime-test-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "carmel-agent-outside-"));
  mkdirSync(join(workingDir, "inside"));
  symlinkSync(join(workingDir, "inside"), join(workingDir, "inside-link"));
  symlinkSync(outsideDir, join(workingDir, "escape"));
  const { tools, env } = createServerExecution(
    makeAgent({ workingDir, permissions: { ...allPermissions(false), read: true } }),
  );
  const lsTool = tools.find((tool) => tool.name === "ls");

  assert.ok(lsTool);
  const result = await executeTool(
    lsTool,
    "call_1",
    { path: "." },
    new AbortController().signal,
    env,
  );
  const output = readToolText(result);
  assert.match(output, /^inside\/$/m);
  assert.match(output, /^inside-link\/$/m);
  assert.doesNotMatch(output, /^escape\/?$/m);
});

test("Pi find rejects an explicit symlink outside AgentExecutionEnv roots", async () => {
  const workingDir = mkdtempSync(join(tmpdir(), "carmel-agent-runtime-test-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "carmel-agent-outside-"));
  writeFileSync(join(outsideDir, "secret.txt"), "top secret");
  symlinkSync(outsideDir, join(workingDir, "escape"));
  const { tools, env } = createServerExecution(
    makeAgent({ workingDir, permissions: { ...allPermissions(false), read: true } }),
  );
  const findTool = tools.find((tool) => tool.name === "find");

  assert.ok(findTool);
  await assert.rejects(
    () =>
      executeTool(
        findTool,
        "call_find",
        { pattern: "**/*.txt", path: "escape" },
        new AbortController().signal,
        env,
      ),
    /outside the agent working directory/,
  );
});

test("bash stays unavailable when no container socket exists", async () => {
  const originalSocket = process.env.CARMEL_PODMAN_SOCKET;
  process.env.CARMEL_PODMAN_SOCKET = join(tmpdir(), "carmel-agent-missing-podman.sock");
  const { env } = createServerExecution(
    makeAgent({ permissions: { ...allPermissions(false), bash: true } }),
  );

  try {
    const result = await env.exec("printf should-not-run", undefined, TEST_CONTEXT);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "shell_unavailable");
  } finally {
    await env.cleanup(TEST_CONTEXT);
    restoreEnv("CARMEL_PODMAN_SOCKET", originalSocket);
  }
});

function executeTool(
  tool: { execute: unknown },
  _id: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  env?: unknown,
) {
  return executeNativeTool(
    tool as import("@earendil-works/pi-durable").ToolRegistration,
    params,
    env as import("@earendil-works/pi-durable/env").ExecutionEnv,
    withAbortSignal(signal, TEST_CONTEXT),
  );
}

function readToolText(result: unknown) {
  if (
    !result ||
    typeof result !== "object" ||
    !("output" in result) ||
    !Array.isArray(result.output)
  )
    return "";
  return result.output
    .flatMap((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? [String(part.text)]
        : [],
    )
    .join("\n");
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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
