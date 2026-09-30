import assert from "node:assert/strict";
import test from "node:test";
import { Duplex } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { McpClient, type JsonRpcMessage } from "@earendil-works/pi-mcp";
import { SandboxMcpTransport, sandboxMcpCommand } from "./mcp-transport.ts";

function frame(stream: number, value: string | Buffer) {
  const bytes = Buffer.from(value);
  const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
function socket(onWrite: (chunk: Buffer) => void = () => {}) {
  return new Duplex({ read() {}, write(chunk, _encoding, callback) { onWrite(chunk); callback(); } });
}

test("sandbox stdio framing preserves fragmented UTF-8 and excludes stderr", async () => {
  const writes: Buffer[] = [];
  const channel = socket((chunk) => writes.push(chunk));
  let releases = 0;
  const transport = new SandboxMcpTransport(async () => channel, () => { releases += 1; });
  const messages: JsonRpcMessage[] = [];
  transport.onMessage((message) => messages.push(message));
  await transport.start();
  const wire = Buffer.concat([frame(2, "server logs are not protocol\n"), frame(1, '{"jsonrpc":"2.0","id":1,"result":{"text":"你好"}}\n')]);
  for (let i = 0; i < wire.length; i++) channel.push(wire.subarray(i, i + 1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 1, result: { text: "你好" } }]);
  await transport.send({ jsonrpc: "2.0", method: "ping" });
  assert.equal(Buffer.concat(writes).toString(), '{"jsonrpc":"2.0","method":"ping"}\n');
  await transport.close(); await transport.close(); assert.equal(releases, 1);
});

test("invalid or oversized stdio messages close the transport and release the container hold", async () => {
  for (const wire of [frame(1, "not json\n"), (() => { const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(0xffffffff, 4); return header; })()]) {
    const channel = socket(); let released = false;
    const transport = new SandboxMcpTransport(async () => channel, () => { released = true; });
    const closed = new Promise<void>((resolve) => transport.onClose(resolve));
    await transport.start(); channel.push(wire); await closed;
    assert.equal(released, true); assert.equal(channel.destroyed, true);
  }
});

test("closing during sandbox attach disposes a late socket", async () => {
  let resolveOpen!: (channel: Duplex) => void;
  const opened = new Promise<Duplex>((resolve) => { resolveOpen = resolve; });
  const channel = socket();
  const transport = new SandboxMcpTransport(() => opened, () => {});
  const started = assert.rejects(transport.start(), /closed/i);
  await transport.close(); resolveOpen(channel); await started;
  assert.equal(channel.destroyed, true);
});

test("Pi's client speaks MCP through the sandbox adapter and EOF terminates a stubborn process", { timeout: 10_000 }, async () => {
  const serverScript = `
    const readline = require('node:readline');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    console.error('stderr stays separate');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result = {};
      if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', serverInfo: {name:'stdio-fixture', version:'1'}, capabilities:{tools:{}} };
      if (message.method === 'tools/list') result = {tools:[{name:'echo', inputSchema:{type:'object',properties:{}}}]};
      if (message.method === 'tools/call') result = {content:[{type:'text',text:'stdio echoed'}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
    });
  `;
  const [command, ...args] = sandboxMcpCommand(process.execPath, ["-e", serverScript]);
  const child = spawn(command!, args, { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const channel = new Duplex({ read() {}, write(chunk, _encoding, callback) { child.stdin.write(chunk, callback); }, final(callback) { child.stdin.end(); callback(); } });
  child.stdout.on("data", (chunk: Buffer) => channel.push(frame(1, chunk)));
  child.stderr.on("data", (chunk: Buffer) => channel.push(frame(2, chunk)));
  const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 2000 });
  try {
    await client.connect(new SandboxMcpTransport(async () => channel, () => {}));
    assert.equal((await client.listTools())[0]?.name, "echo");
    assert.deepEqual((await client.callTool("echo", {})).content, [{ type: "text", text: "stdio echoed" }]);
    await client.close();
    const [code] = await exited;
    assert.equal(code, 0);
  } finally { await client.close(); child.kill("SIGTERM"); }
});

test("Docker stdio attach preserves upgrade bytes and starts an exec without a TTY", async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { attachExecStdio } = await import("./podman.ts");
  const directory = await mkdtemp(join(tmpdir(), "carmel-mcp-socket-"));
  const path = join(directory, "podman.sock");
  const previous = process.env.CARMEL_PODMAN_SOCKET;
  process.env.CARMEL_PODMAN_SOCKET = path;
  let createBody: unknown;
  let startBody: unknown;
  let channel: Duplex | undefined;
  const daemon = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    createBody = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(201, { "content-type": "application/json" }); response.end('{"Id":"fixture-exec"}');
  });
  daemon.on("upgrade", (request, socket, head) => {
    channel = socket;
    let pending = head;
    const length = Number(request.headers["content-length"]);
    const receive = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < length) return;
      startBody = JSON.parse(pending.subarray(0, length).toString());
      socket.off("data", receive);
      socket.write(Buffer.concat([
        Buffer.from("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"),
        frame(1, '{"jsonrpc":"2.0","method":"fixture-ready"}\n'),
      ]));
    };
    socket.on("data", receive); receive(Buffer.alloc(0));
  });
  await new Promise<void>((resolve) => daemon.listen(path, resolve));
  let transport: SandboxMcpTransport | undefined;
  try {
    const spec = { cmd: ["node", "server.js"], workingDir: "/workspace", env: ["TOKEN=fixture"] };
    const attached = await attachExecStdio("fixture-container", spec);
    transport = new SandboxMcpTransport(async () => attached.socket, () => {});
    const message = new Promise<JsonRpcMessage>((resolve) => transport!.onMessage(resolve));
    await transport.start();
    assert.deepEqual(await message, { jsonrpc: "2.0", method: "fixture-ready" });
    assert.deepEqual(createBody, { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: spec.cmd, WorkingDir: spec.workingDir, Env: spec.env });
    assert.deepEqual(startBody, { Detach: false, Tty: false });
  } finally {
    await transport?.close(); channel?.destroy();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    if (previous === undefined) delete process.env.CARMEL_PODMAN_SOCKET; else process.env.CARMEL_PODMAN_SOCKET = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
