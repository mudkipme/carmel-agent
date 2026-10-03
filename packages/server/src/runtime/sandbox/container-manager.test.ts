import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { agents } from "../../db/schema.ts";

test("replacement waits for teardown and retains the old profile owner when removal fails", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "container-owner-"));
  const previousSocket = process.env.CARMEL_PODMAN_SOCKET;
  const previousData = process.env.CARMEL_AGENT_DATA_DIR;
  process.env.CARMEL_PODMAN_SOCKET = join(directory, "podman.sock");
  process.env.CARMEL_AGENT_DATA_DIR = directory;
  let creates = 0;
  let delayedDelete: ServerResponse | undefined;
  let sawDelete!: () => void;
  const deleting = new Promise<void>((resolve) => { sawDelete = resolve; });
  let holdDelete = true;
  const specs: Array<{ HostConfig: { Init: boolean } }> = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://podman").pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
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
    if (path.endsWith("/exec")) return json({ Id: "prepare-profile" }, 201);
    if (path.includes("/exec/") && path.endsWith("/json")) return json({ ExitCode: 0 });
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
    await assert.rejects(reapManagedContainers(), /Listing managed containers failed/, "a failed owner lookup cannot count as an empty list");
  } finally {
    holdDelete = false; delayedDelete?.end();
    await shutdownContainerManager();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousSocket === undefined) delete process.env.CARMEL_PODMAN_SOCKET; else process.env.CARMEL_PODMAN_SOCKET = previousSocket;
    if (previousData === undefined) delete process.env.CARMEL_AGENT_DATA_DIR; else process.env.CARMEL_AGENT_DATA_DIR = previousData;
    await rm(directory, { recursive: true, force: true });
  }
});
