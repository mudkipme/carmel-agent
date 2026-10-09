import assert from "node:assert/strict";
import { test } from "node:test";
import { Duplex } from "node:stream";
import { WorkerClient, knowledgeContainerSpec } from "./worker-client.ts";

function connection() {
  let sent: { id: string };
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      sent = JSON.parse(chunk.toString());
      done();
    },
  });
  const client = new WorkerClient("test", socket);
  function response(result: unknown) {
    const body = Buffer.from(JSON.stringify({ id: sent.id, result }) + "\n");
    const frame = Buffer.alloc(8 + body.length);
    frame[0] = 1;
    frame.writeUInt32BE(body.length, 4);
    body.copy(frame, 8);
    return frame;
  }
  return { socket, client, response };
}

test("runner protocol handles fragmented multiplexed UTF-8 and fails closed on corruption", async () => {
  const { socket, client, response } = connection();
  const pending = client.request({ op: "search" }, 1000);
  const frame = response({ title: "家庭预算" });
  for (let i = 0; i < frame.length; i += 3)
    socket.push(frame.subarray(i, i + 3));
  assert.deepEqual(await pending, { title: "家庭预算" });
  const next = client.request({ op: "status" }, 1000);
  const malformed = Buffer.alloc(8);
  malformed[0] = 1;
  malformed.writeUInt32BE(1024 * 1024, 4);
  socket.push(malformed);
  await assert.rejects(next, /Invalid knowledge runner response/);
  assert.equal(client.closed, true);
});

test("aborting a runner request closes the worker transport and rejects future requests", async () => {
  const { client, socket } = connection();
  const abort = new AbortController();
  const pending = client.request({ op: "embed" }, 60_000, abort.signal);
  abort.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(socket.destroyed, true);
  await assert.rejects(client.request({ op: "status" }, 1000), /unavailable/);
});

test("knowledge workers mount only registered sources and explicitly provisioned state", () => {
  const old = process.env.CARMEL_KNOWLEDGE_GPU;
  process.env.CARMEL_KNOWLEDGE_GPU = "nvidia.com/gpu=all";
  try {
    const plan = {
      agentId: "a1",
      stateDir: "/test/state",
      modelCacheDir: "/test/shared-models",
      embeddingModel: "hf:org/model/model.gguf",
      settings: {
        enabled: true,
        acceleration: "cpu" as const,
      },
      network: false,
      sources: [{ id: "docs", hostPath: "/test/docs", description: "Docs" }],
    };
    const identity = {
      uid: 1000,
      gid: 1000,
      user: "1000:1000",
      runtime: "podman" as const,
      usernsMode: "keep-id" as const,
      socket: "/test/socket",
    };
    const cpu = knowledgeContainerSpec(plan, identity);
    assert.equal(cpu.HostConfig.NetworkMode, "none");
    assert.equal(cpu.HostConfig.ReadonlyRootfs, true);
    assert.equal(cpu.HostConfig.DeviceRequests, undefined);
    assert.equal(cpu.User, "1000:1000");
    assert.equal(cpu.HostConfig.Binds.length, 3);
    assert.match(
      cpu.HostConfig.Binds[1]!,
      /^\/test\/shared-models:\/models\/cache:ro/,
    );
    const setup = knowledgeContainerSpec({ ...plan, network: true }, identity);
    assert.match(
      setup.HostConfig.Binds[1]!,
      /^\/test\/shared-models:\/models\/cache:rw/,
    );
    assert.match(cpu.HostConfig.Binds[2]!, /^\/test\/docs:\/sources\/docs:ro/);
    assert.ok(!cpu.HostConfig.Binds.some((b) => b.includes("socket")));
    assert.ok(!cpu.Env.some((e) => /KEY=|TOKEN=|SECRET=/.test(e)));
    const gpu = knowledgeContainerSpec(
      { ...plan, settings: { ...plan.settings, acceleration: "vulkan" } },
      identity,
    );
    assert.deepEqual(gpu.HostConfig.DeviceRequests, [
      { Driver: "cdi", DeviceIDs: ["nvidia.com/gpu=all"] },
    ]);
    assert.ok(gpu.Env.includes("QMD_LLAMA_GPU=vulkan"));
  } finally {
    if (old === undefined) delete process.env.CARMEL_KNOWLEDGE_GPU;
    else process.env.CARMEL_KNOWLEDGE_GPU = old;
  }
});
