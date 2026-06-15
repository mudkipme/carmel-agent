import test from "node:test";
import assert from "node:assert/strict";
import { createStreamDemuxer, parseImageRef } from "./podman.ts";
import { containerWorkdir } from "./container-manager.ts";

test("demuxer reassembles multiplexed docker frames split across chunks", () => {
  const chunks: Buffer[] = [];
  const demux = createStreamDemuxer((payload) => chunks.push(Buffer.from(payload)));

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

  assert.equal(Buffer.concat(chunks).toString("utf-8"), "hello world!");
});

test("demuxer leaves an incomplete trailing frame buffered", () => {
  const chunks: Buffer[] = [];
  const demux = createStreamDemuxer((payload) => chunks.push(Buffer.from(payload)));
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
  assert.equal(containerWorkdir("/data/agents/a/workspace", "/data/agents/a/workspace"), "/workspace");
  assert.equal(containerWorkdir("/data/agents/a/workspace", "/data/agents/a/workspace/src/lib"), "/workspace/src/lib");
});

test("containerWorkdir falls back to the workspace root for outside paths", () => {
  assert.equal(containerWorkdir("/data/agents/a/workspace", "/etc"), "/workspace");
  assert.equal(containerWorkdir("/data/agents/a/workspace", "/data/agents/b/workspace"), "/workspace");
});
