import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { agents } from "../../db/schema.ts";

test("container identity, initialization, and replacement fail safely", { timeout: 10000 }, async (t) => {
  // The daemon is mocked, so model the server's identity too. CI may run this
  // test as root; production must still reject a real root server or runner.
  const uid = 1234, gid = 2345;
  const unixProcess = process as Required<Pick<NodeJS.Process, "getuid" | "getgid">>;
  t.mock.method(unixProcess, "getuid", () => uid);
  t.mock.method(unixProcess, "getgid", () => gid);
  const directory = await mkdtemp(join(tmpdir(), "container-owner-"));
  const previousSocket = process.env.CARMEL_PODMAN_SOCKET;
  const previousData = process.env.CARMEL_AGENT_DATA_DIR;
  const previousUid = process.env.CARMEL_HOST_UID;
  const previousGid = process.env.CARMEL_HOST_GID;
  process.env.CARMEL_HOST_UID = String(uid);
  process.env.CARMEL_HOST_GID = String(gid);
  process.env.CARMEL_PODMAN_SOCKET = join(directory, "podman.sock");
  process.env.CARMEL_AGENT_DATA_DIR = directory;
  let creates = 0;
  let delayedDelete: ServerResponse | undefined;
  let sawDelete!: () => void;
  const deleting = new Promise<void>((resolve) => { sawDelete = resolve; });
  let holdDelete = true;
  let runtime: "docker" | "podman" = "docker";
  let securityOptions = ["name=seccomp,profile=builtin"];
  let initializeExitCode = 0;
  let execId = 0;
  let browserPreparations = 0;
  const executions = new Map<string, boolean>();
  const fixtureExecutions = new Map<string, { command: string; cwd: string }>();
  const fixtureOutput = `large fixture output from ${directory}\n`;
  const specs: Array<{ User: string; Env: string[]; HostConfig: { Binds: string[]; Init: boolean; UsernsMode: string; CapDrop: string[]; SecurityOpt: string[] } }> = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://podman").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path.endsWith("/version")) return json({ Os: "linux", Components: [{ Name: runtime === "docker" ? "Engine" : "Podman Engine" }] });
    if (path.endsWith("/libpod/info")) return json({ host: { security: { rootless: true }, idMappings: {
      uidmap: [{ container_id: 0, host_id: uid, size: 1 }],
      gidmap: [{ container_id: 0, host_id: gid, size: 1 }],
    } } });
    if (path.endsWith("/info")) return json({ SecurityOptions: securityOptions });
    if (path.includes("/images/")) return json({});
    if (path.endsWith("/containers/create")) {
      let body = ""; for await (const chunk of req) body += chunk;
      specs.push(JSON.parse(body)); return json({ Id: `container-${++creates}` }, 201);
    }
    if (path.endsWith("/containers/json")) return json({ error: "Cannot establish old owners" }, 500);
    if (req.method === "DELETE") {
      if (holdDelete) { delayedDelete = res; sawDelete(); return; }
      res.writeHead(204); res.end(); return;
    }
    if (path.includes("/containers/") && path.endsWith("/json")) return json({ State: { Running: true } });
    if (path.endsWith("/exec")) {
      let body = ""; for await (const chunk of req) body += chunk;
      const spec = JSON.parse(body) as { Cmd: string[]; User?: string; WorkingDir: string };
      assert.equal(spec.User, undefined, "execs inherit the container's non-root identity");
      const initializing = spec.Cmd[2]!.includes("Sandbox user mapping");
      if (!initializing) browserPreparations++;
      const id = `exec-${++execId}`;
      executions.set(id, initializing);
      if (spec.Cmd.at(-1)?.startsWith("fixture-output")) fixtureExecutions.set(id, { command: spec.Cmd.at(-1)!, cwd: spec.WorkingDir });
      return json({ Id: id }, 201);
    }
    if (path.includes("/exec/") && path.endsWith("/json")) {
      const id = path.split("/").at(-2)!;
      return json({ ExitCode: executions.get(id) ? initializeExitCode : fixtureExecutions.get(id)?.command === "fixture-output-timeout" ? 124 : 0 });
    }
    if (path.includes("/exec/") && path.endsWith("/start") && fixtureExecutions.has(path.split("/").at(-2)!)) {
      const payload = Buffer.from(fixtureOutput);
      const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(payload.length, 4);
      res.writeHead(200); res.end(Buffer.concat([header, payload])); return;
    }
    res.writeHead(path.includes("/exec/") ? 200 : 204); res.end();
  });
  await new Promise<void>((resolve) => server.listen(process.env.CARMEL_PODMAN_SOCKET, resolve));
  const { ensureAgentContainer, killAgentContainer, reapManagedContainers, shutdownContainerManager } = await import("./container-manager.ts");
  const agent = { id: "test-profile-owner", workingDir: join(directory, "workspace"), workingDirMode: "manual", mounts: [] } as unknown as typeof agents.$inferSelect;
  try {
    assert.equal(await ensureAgentContainer(agent, { network: false }), "container-1");
    const stopped = assert.rejects(killAgentContainer(agent.id), /refusing to reuse/);
    await deleting;
    const replacement = assert.rejects(ensureAgentContainer(agent, { network: false }), /refusing to reuse/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(creates, 1, "a pending teardown cannot start a second profile owner");
    delayedDelete!.writeHead(500); delayedDelete!.end();
    await Promise.all([stopped, replacement]);
    assert.equal(await ensureAgentContainer(agent, { network: false }), "container-1", "failed removal must keep the original owner tracked");
    holdDelete = false;
    await killAgentContainer(agent.id);
    assert.equal(await ensureAgentContainer(agent, { network: false }), "container-2");
    assert.ok(specs.every((spec) => spec.HostConfig.Init === true));
    for (const spec of specs) {
      assert.equal(spec.User, `${uid}:${gid}`);
      assert.equal(spec.HostConfig.UsernsMode, "host");
      assert.deepEqual(spec.HostConfig.CapDrop, ["ALL"]);
      assert.deepEqual(spec.HostConfig.SecurityOpt, ["no-new-privileges"]);
      assert.ok(spec.Env.some(value => value.startsWith("QMD_EMBED_MODEL=")));
      assert.ok(spec.Env.includes("QMD_LLAMA_GPU=auto"));
      assert.ok(spec.HostConfig.Binds.some(bind => bind.startsWith(`${directory}/knowledge-models:/home/agent/.cache/qmd/models:ro`)));
      assert.ok(!spec.Env.some(value => /^(INDEX_PATH|XDG_CACHE_HOME|QMD_CONFIG_DIR)=/.test(value)));
    }
    await assert.rejects(reapManagedContainers(), /Listing managed containers failed/, "a failed owner lookup cannot count as an empty list");
    await killAgentContainer(agent.id);
    for (const option of ["name=rootless", "name=userns"]) {
      securityOptions = [option];
      await assert.rejects(ensureAgentContainer(agent, { network: false }), /not supported/);
      assert.equal(creates, 2, "unsupported runtimes never create a runner");
    }
    securityOptions = [];
    initializeExitCode = 1;
    const previousPreparations = browserPreparations;
    await assert.rejects(ensureAgentContainer(agent, { network: false }), /initialize the non-root sandbox/);
    assert.equal(browserPreparations, previousPreparations, "failed setup cannot proceed to browser or agent commands");
    initializeExitCode = 0;
    runtime = "podman";
    assert.equal(await ensureAgentContainer(agent, { network: false }), "container-4");
    assert.equal(specs.at(-1)!.HostConfig.UsernsMode, "keep-id");

    // Real execution-env spill handling over the mocked daemon: returned paths
    // must work in both bash and the server's guarded filesystem tools.
    const { AgentExecutionEnv } = await import("../execution-env.ts");
    const { BACKGROUND_CONTEXT, getOrThrow } = await import("../../effectors/pi-durable/index.ts");
    const { initialize } = await import("../../db/index.ts");
    initialize();
    const env = new AgentExecutionEnv({ ...agent, workingDirMode: "default", permissions: { read: true, write: true, edit: true, bash: true, network: false } });
    try {
      for (const command of ["fixture-output", "fixture-output-timeout"]) {
        const result = await env.exec(command, { cwd: "/tmp", timeout: 1, spill: { afterBytes: 4, afterLines: 100 } }, BACKGROUND_CONTEXT);
        const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
        assert.ok(spillPath, result.ok ? JSON.stringify(result.value) : result.error.message);
        assert.match(spillPath, /^\/tmp\/output-/);
        assert.equal(getOrThrow(await env.readTextFile(spillPath, BACKGROUND_CONTEXT)), fixtureOutput);
        if (command === "fixture-output") assert.ok(result.ok);
        else {
          assert.equal(result.ok, false);
          if (!result.ok) assert.equal(result.error.code, "timeout");
        }
        assert.equal([...fixtureExecutions.values()].at(-1)?.cwd, "/tmp");
        assert.equal([...fixtureExecutions.values()].at(-1)?.command, command);
      }
    } finally { await env.cleanup(BACKGROUND_CONTEXT); }
  } finally {
    holdDelete = false; delayedDelete?.end();
    await shutdownContainerManager();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousSocket === undefined) delete process.env.CARMEL_PODMAN_SOCKET; else process.env.CARMEL_PODMAN_SOCKET = previousSocket;
    if (previousData === undefined) delete process.env.CARMEL_AGENT_DATA_DIR; else process.env.CARMEL_AGENT_DATA_DIR = previousData;
    if (previousUid === undefined) delete process.env.CARMEL_HOST_UID; else process.env.CARMEL_HOST_UID = previousUid;
    if (previousGid === undefined) delete process.env.CARMEL_HOST_GID; else process.env.CARMEL_HOST_GID = previousGid;
    await rm(directory, { recursive: true, force: true });
  }
});
