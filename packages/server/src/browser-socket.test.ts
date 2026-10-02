import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import { db, migrate } from "./db/index.ts";
import { agents, authSessions } from "./db/schema.ts";
import { createSession, createUser } from "./test-support.ts";
import { attachBrowserSocket } from "./browser-socket.ts";
import { browserControl, deleteBrowserControl } from "./runtime/browser-control.ts";
import type { connectBrowser } from "./runtime/sandbox/browser-sessions.ts";
import type { BrowserServerMessage } from "@carmel-agent/shared";

migrate();
const server = createServer((_request, response) => response.writeHead(404).end());
const forwarded: unknown[] = [];
const bridge: typeof connectBrowser = async (_agent, onMessage) => {
  queueMicrotask(() => onMessage({ type: "ready" }));
  return { send: (message) => forwarded.push(message), close: () => {} };
};
const wss = attachBrowserSocket(server, bridge);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
after(() => { for (const client of wss.clients) client.terminate(); wss.close(); server.close(); });

function cookie(userId: string) {
  const token = randomUUID();
  db.insert(authSessions).values({ id: randomUUID(), userId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 60000, createdAt: Date.now() }).run();
  return `carmel_session=${token}`;
}
function fixture() {
  const fixture = createSession();
  db.update(agents).set({ shared: true, permissions: { read: true, write: false, edit: false, bash: true, network: false } }).where(eq(agents.id, fixture.agentId)).run();
  return fixture;
}
async function connect(agentId: string, credential: string, requestOrigin = origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/browser?agent=${agentId}`, { headers: { cookie: credential, origin: requestOrigin } });
  const messages: BrowserServerMessage[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await once(ws, "open");
  const wait = async (predicate: (message: BrowserServerMessage) => boolean) => {
    const deadline = Date.now() + 3000;
    while (!messages.some(predicate)) {
      if (Date.now() > deadline) throw new Error("Expected browser message did not arrive.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await wait((message) => message.type === "ready");
  return { ws, messages, wait, send: (message: unknown) => { messages.length = 0; ws.send(JSON.stringify(message)); } };
}

test("a shared agent exposes one browser to its users, but only its controller can send input", async () => {
  const f = fixture();
  const owner = await connect(f.agentId, cookie(f.userId));
  const guest = await connect(f.agentId, cookie(createUser()));
  try {
    forwarded.length = 0;
    guest.send({ type: "input_keyboard", eventType: "char", text: "blocked" });
    await guest.wait((message) => message.type === "error");
    assert.equal(forwarded.length, 0);
    owner.send({ type: "take_control" });
    await owner.wait((message) => message.type === "control" && message.hasControl);
    guest.send({ type: "take_control" });
    await guest.wait((message) => message.type === "error");
    owner.send({ type: "input_keyboard", eventType: "char", text: "demo input" });
    owner.send({ type: "resume" });
    await owner.wait((message) => message.type === "control" && message.state.phase === "agent");
    assert.ok(forwarded.some((message) => (message as { text?: string }).text === "demo input"));
    guest.send({ type: "take_control" });
    await guest.wait((message) => message.type === "control" && message.hasControl);
    guest.ws.close();
    await once(guest.ws, "close");
    await owner.wait((message) => message.type === "control" && message.state.phase === "waiting");
    assert.equal(browserControl(f.agentId).isPaused, true);
    owner.send({ type: "take_control" });
    await owner.wait((message) => message.type === "control" && message.hasControl);
    owner.send({ type: "resume" });
    await owner.wait((message) => message.type === "control" && message.state.phase === "agent");
  } finally { owner.ws.close(); guest.ws.close(); deleteBrowserControl(f.agentId); }
});

test("browser websocket rejects cross-origin, unauthenticated, private-agent, and disabled access", async () => {
  const f = fixture();
  const credential = cookie(createUser());
  await assert.rejects(connect(f.agentId, credential, "https://untrusted.example"), /403/);
  await assert.rejects(connect(f.agentId, ""), /401/);
  await assert.rejects(connect(f.agentId, "carmel_session=%GG"), /401/);
  db.update(agents).set({ shared: false }).where(eq(agents.id, f.agentId)).run();
  await assert.rejects(connect(f.agentId, credential), /404/);
  db.update(agents).set({ permissions: { read: true, write: false, edit: false, bash: false, network: false } }).where(eq(agents.id, f.agentId)).run();
  await assert.rejects(connect(f.agentId, cookie(f.userId)), /403/);
});

test("revoking a shared user's access closes their connection before the next input", async () => {
  const f = fixture();
  const guest = await connect(f.agentId, cookie(createUser()));
  guest.send({ type: "take_control" });
  await guest.wait((message) => message.type === "control" && message.hasControl);
  db.update(agents).set({ shared: false }).where(eq(agents.id, f.agentId)).run();
  const closed = once(guest.ws, "close");
  guest.send({ type: "input_keyboard", eventType: "char", text: "revoked" });
  await closed;
  assert.equal(forwarded.some((message) => (message as { text?: string }).text === "revoked"), false);
  assert.equal(browserControl(f.agentId).state.phase, "waiting");
  deleteBrowserControl(f.agentId);
});
