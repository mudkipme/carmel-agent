/** Opt-in real Chromium test. Creates and deletes only its own agent/container and temp files. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = process.env.CARMEL_BROWSER_TEST_IMAGE;
if (!image) throw new Error("Set CARMEL_BROWSER_TEST_IMAGE to a locally built runner image.");
const directory = await mkdtemp(join(tmpdir(), "carmel-browser-sandbox-"));
process.env.DATABASE_URL = ":memory:";
process.env.CARMEL_AGENT_DATA_DIR = directory;
process.env.CARMEL_BASH_IMAGE = image;
process.env.CARMEL_BASH_GPU = "";
process.env.CARMEL_BASH_MEMORY_MB = "1024";
process.env.CARMEL_HOST_DATA_DIR = directory;
process.env.CARMEL_HOST_UID ??= String(process.getuid!());
process.env.CARMEL_HOST_GID ??= String(process.getgid!());
const { db, migrate } = await import("../src/db/index.ts");
const { agents } = await import("../src/db/schema.ts");
const { createSession } = await import("../src/test-support.ts");
const { eq } = await import("drizzle-orm");
const { ensureAgentContainer, killAgentContainer, discardAgentContainer, shutdownContainerManager } = await import("../src/runtime/sandbox/container-manager.ts");
const { attachExecStdio, execInContainer, createStreamDemuxer } = await import("../src/runtime/sandbox/runtime-client.ts");
const { connectBrowser } = await import("../src/runtime/sandbox/browser-sessions.ts");
const { sandboxEnv } = await import("../src/runtime/sandbox/bash-operations.ts");
migrate();
const fixture = createSession();
db.update(agents).set({ workingDir: directory, permissions: { read: true, write: true, edit: true, bash: true, network: false } }).where(eq(agents.id, fixture.agentId)).run();
const agent = db.select().from(agents).where(eq(agents.id, fixture.agentId)).get()!;
let bridge: Awaited<ReturnType<typeof connectBrowser>> | undefined;
let webServer: Awaited<ReturnType<typeof attachExecStdio>> | undefined;
const page = `<!doctype html><title>Browser sign-in fixture</title><style>body{font:20px sans-serif}input,button{position:absolute;left:32px;width:300px;height:44px}input{top:80px}button{top:160px}</style><h1>Sign in</h1><input aria-label="Account"><button onclick="document.cookie='signed_in=yes;path=/;max-age=3600';document.body.innerHTML='<h1>Signed in as '+document.querySelector('input').value+'</h1>'">Sign in</button>`;
try {
  let container = await ensureAgentContainer(agent, { network: false });
  const cli = async (...args: string[]) => {
    let stdout = "", stderr = "";
    const result = await execInContainer(container, { cmd: ["/usr/local/bin/agent-browser", "--session", "carmel", "--json", ...args], workingDir: directory, env: sandboxEnv() }, {
      onStdout: (chunk) => { stdout += chunk; }, onStderr: (chunk) => { stderr += chunk; }, signal: AbortSignal.timeout(35000),
    });
    assert.equal(result.exitCode, 0, stderr || stdout);
    const response = JSON.parse(stdout); assert.equal(response.success, true, response.error);
    return response.data;
  };
  const startWebServer = async () => {
    webServer = await attachExecStdio(container, { cmd: ["node", "-e", `const http=require('node:http');http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(${JSON.stringify(page)})}).listen(8123,'127.0.0.1',()=>console.log('ready'));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`], workingDir: directory, env: sandboxEnv() });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Fixture server did not start")), 10000);
      const demux = createStreamDemuxer((stream, chunk) => { if (stream === 1 && chunk.toString().includes("ready")) { clearTimeout(timeout); resolve(); } });
      webServer!.socket.on("data", demux);
    });
  };
  await startWebServer();
  await cli("open", "http://127.0.0.1:8123");
  const messages: Array<{ type: string; [key: string]: unknown }> = [];
  const open = async () => {
    const connection = await connectBrowser(agent, (message) => {
      messages.push(message);
      if (message.type === "frame") bridge?.send({ type: "ack", seq: message.seq });
    }, () => {});
    bridge = connection;
    const deadline = Date.now() + 40000;
    while (!messages.some((message) => message.type === "frame")) {
      const error = messages.find((message) => message.type === "error");
      if (error) throw new Error(String(error.message));
      if (Date.now() > deadline) throw new Error(`No browser frame: ${JSON.stringify(messages)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await open();
  bridge!.send({ type: "input_mouse", eventType: "mousePressed", x: 70, y: 100, button: "left", clickCount: 1 });
  bridge!.send({ type: "input_mouse", eventType: "mouseReleased", x: 70, y: 100, button: "left", clickCount: 1 });
  bridge!.send({ type: "input_keyboard", eventType: "char", text: "human@example.test" });
  bridge!.send({ type: "input_mouse", eventType: "mousePressed", x: 70, y: 180, button: "left", clickCount: 1 });
  bridge!.send({ type: "input_mouse", eventType: "mouseReleased", x: 70, y: 180, button: "left", clickCount: 1 });
  try { await cli("wait", "--text", "Signed in as human@example.test"); }
  catch (error) { console.log("Browser diagnostic:", JSON.stringify(await cli("snapshot"))); throw error; }
  const snapshot = await cli("snapshot");
  assert.match(JSON.stringify(snapshot), /Signed in as human@example.test/);
  // Change a visible pixel after sign-in and require a new image over the existing
  // connection. A first frame alone would miss a stalled screencast.
  const previousFrame = messages.findLast((message) => message.type === "frame");
  await cli("eval", "document.body.style.background = 'rgb(150, 210, 255)'");
  const frameDeadline = Date.now() + 10000;
  while (!messages.some((message) => message.type === "frame" && Number(message.seq) > Number(previousFrame?.seq) && message.data !== previousFrame?.data)) {
    if (Date.now() > frameDeadline) throw new Error("The browser preview stopped updating after sign-in.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  bridge!.close(); bridge = undefined; messages.length = 0;
  await open();
  assert.match(JSON.stringify(await cli("get", "text", "body")), /Signed in as human@example.test/);
  assert.match(JSON.stringify(await cli("cookies")), /signed_in/);
  console.log("PASS: Chromium streams through the sandbox bridge, remote click/text sign-in works, reconnect keeps the page and cookies.");
  bridge!.close(); bridge = undefined; messages.length = 0;
  await cli("close"); // Flush persistent cookies before simulating leftover process locks.
  const seeded = await execInContainer(container, {
    cmd: ["node", "-e", "const fs=require('node:fs');const p='/home/agent/.agent-browser/profile/';for(const [name,target] of [['SingletonLock','previous-container-63'],['SingletonCookie','12345'],['SingletonSocket','/tmp/old-browser/SingletonSocket']]){try{fs.unlinkSync(p+name)}catch(e){if(e.code!=='ENOENT')throw e}fs.symlinkSync(target,p+name)}"],
    workingDir: directory, env: sandboxEnv(),
  }, { onStdout: () => {}, onStderr: () => {}, signal: AbortSignal.timeout(10000) });
  assert.equal(seeded.exitCode, 0);
  await killAgentContainer(agent.id);
  container = await ensureAgentContainer(agent, { network: false });
  await startWebServer();
  await cli("open", "http://127.0.0.1:8123");
  await open();
  assert.match(JSON.stringify(await cli("cookies")), /signed_in/);
  console.log("PASS: A replacement sandbox recovers stale Chromium locks, streams again, and retains saved cookies.");
} finally {
  bridge?.close(); webServer?.socket.end(); webServer?.socket.destroy();
  await discardAgentContainer(agent.id);
  await shutdownContainerManager();
  await rm(directory, { recursive: true, force: true });
}
