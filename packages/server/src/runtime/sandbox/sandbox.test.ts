import test from "node:test";
import assert from "node:assert/strict";
import type { agents } from "../../db/schema.ts";
import { createStreamDemuxer, parseImageRef } from "./podman.ts";
import { buildBinds, containerSignature, containerWorkdir, resolveContainerWorkspace } from "./container-manager.ts";

type AgentRecord = typeof agents.$inferSelect;

function manualAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return { id: "agent_test", workingDirMode: "manual", workingDir: "/srv/projects/app", mounts: [], ...overrides } as AgentRecord;
}

test("demuxer reassembles multiplexed docker frames split across chunks", () => {
  const chunks: Array<{ stream: number; payload: Buffer }> = [];
  const demux = createStreamDemuxer((stream, payload) => chunks.push({ stream, payload: Buffer.from(payload) }));

  const frame = (stream: number, text: string) => {
    const payload = Buffer.from(text, "utf-8");
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  const stream = Buffer.concat([frame(1, "hello "), frame(2, "world"), frame(1, "!")]);
  // Feed one byte at a time to exercise frames spanning chunk boundaries.
  for (const byte of stream) demux(Buffer.from([byte]));

  assert.deepEqual(
    chunks.map(({ stream, payload }) => ({ stream, text: payload.toString("utf8") })),
    [
      { stream: 1, text: "hello " },
      { stream: 2, text: "world" },
      { stream: 1, text: "!" },
    ],
  );
});

test("demuxer leaves an incomplete trailing frame buffered", () => {
  const chunks: Buffer[] = [];
  const demux = createStreamDemuxer((_stream, payload) => chunks.push(Buffer.from(payload)));
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(5, 4);

  demux(Buffer.concat([header, Buffer.from("abc")]));
  assert.equal(chunks.length, 0);
  demux(Buffer.from("de"));
  assert.equal(Buffer.concat(chunks).toString("utf-8"), "abcde");
});

test("parseImageRef splits tags but not registry ports", () => {
  assert.deepEqual(parseImageRef("docker.io/library/debian:stable-slim"), {
    name: "docker.io/library/debian",
    tag: "stable-slim",
  });
  assert.deepEqual(parseImageRef("alpine"), { name: "alpine", tag: "latest" });
  assert.deepEqual(parseImageRef("localhost:5000/tools"), { name: "localhost:5000/tools", tag: "latest" });
  assert.deepEqual(parseImageRef("localhost:5000/tools:dev"), { name: "localhost:5000/tools", tag: "dev" });
});

test("containerWorkdir maps host paths onto the workspace mount", () => {
  assert.equal(containerWorkdir("/data/agents/a/workspace", "/data/agents/a/workspace", "/workspace"), "/workspace");
  assert.equal(
    containerWorkdir("/data/agents/a/workspace", "/data/agents/a/workspace/src/lib", "/workspace"),
    "/workspace/src/lib",
  );
});

test("containerWorkdir falls back to the mount root for outside paths", () => {
  assert.equal(containerWorkdir("/data/agents/a/workspace", "/etc", "/workspace"), "/workspace");
  assert.equal(containerWorkdir("/data/agents/a/workspace", "/data/agents/b/workspace", "/workspace"), "/workspace");
});

test("containerWorkdir preserves an absolute mount path for manual workspaces", () => {
  assert.equal(containerWorkdir("/srv/projects/app", "/srv/projects/app/src", "/srv/projects/app"), "/srv/projects/app/src");
});

test("resolveContainerWorkspace keeps the absolute path for manual workspaces", () => {
  assert.equal(resolveContainerWorkspace({ workingDirMode: "manual", workingDir: "/srv/projects/app" } as AgentRecord), "/srv/projects/app");
  assert.equal(resolveContainerWorkspace({ workingDirMode: "default", workingDir: "agents/a/workspace" } as AgentRecord), "/workspace");
});

test("containerSignature changes when the workspace dir, mounts, or network change", () => {
  const base = containerSignature(manualAgent(), { network: false });
  assert.equal(base, containerSignature(manualAgent(), { network: false }), "stable for identical config");
  assert.notEqual(base, containerSignature(manualAgent({ workingDir: "/srv/projects/other" }), { network: false }));
  assert.notEqual(base, containerSignature(manualAgent({ mounts: [{ source: "/srv/shared" }] }), { network: false }));
  assert.notEqual(base, containerSignature(manualAgent(), { network: true }));
});

test("buildBinds adds the workspace, /tmp, and extra mounts with SELinux relabel", () => {
  const binds = buildBinds("/host/data/agents/a/workspace", "/workspace", "/host/data/agents/a/tmp", [
    { source: "/srv/shared", target: "/refs", readOnly: true },
    { source: "/srv/cache" },
    { source: "  " },
  ]);
  assert.deepEqual(binds, [
    "/host/data/agents/a/workspace:/workspace:rw,z",
    "/host/data/agents/a/tmp:/tmp:rw,z",
    "/srv/shared:/refs:ro,z",
    "/srv/cache:/srv/cache:rw,z",
  ]);
});
