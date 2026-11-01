import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { eq } from "drizzle-orm";
import type { UpdateServerMessage } from "@carmel-agent/shared";
import { db, initialize } from "./db/index.ts";
import { authSessions, sessions } from "./db/schema.ts";
import { createSession, createUser } from "./test-support.ts";
import { attachUpdateSocket } from "./update-socket.ts";
import { createActiveAgentRun, emitRunEvent, finishAgentRun } from "./runtime/run-stream.ts";

initialize();
const server = createServer((_request, response) => response.writeHead(404).end());
const wss = attachUpdateSocket(server);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close();
});

test("one connection multiplexes runs and two clients receive the same committed state changes", async () => {
  const fixture = createSession();
  const first = await connect(cookie(fixture.userId));
  const second = await connect(cookie(fixture.userId));
  let aborts = 0;
  const runs = ["first", "second"].map((suffix) =>
    createActiveAgentRun({
      runId: randomUUID(),
      userId: fixture.userId,
      sessionId: `${fixture.sessionId}_${suffix}`,
      abort: () => {
        aborts++;
      },
    }),
  );
  try {
    first.send({ type: "watch_run", id: "a", runId: runs[0]!.runId, after: 0 });
    first.send({ type: "watch_run", id: "b", runId: runs[1]!.runId, after: 0 });
    second.send({ type: "watch_run", id: "c", runId: runs[0]!.runId, after: 0 });
    await Promise.all([
      first.wait((m) => m.type === "run_open" && m.id === "b"),
      second.wait((m) => m.type === "run_open"),
    ]);
    emitRunEvent(runs[0]!, { type: "turn_end" });
    emitRunEvent(runs[1]!, { type: "agent_end" });
    const [a, b, c] = await Promise.all([
      first.wait((m) => m.type === "run_event" && m.id === "a"),
      first.wait((m) => m.type === "run_event" && m.id === "b"),
      second.wait((m) => m.type === "run_event" && m.id === "c"),
    ]);
    assert.equal(a.type === "run_event" && a.envelope.event.type, "turn_end");
    assert.equal(b.type === "run_event" && b.envelope.event.type, "agent_end");
    assert.deepEqual(a.type === "run_event" && a.envelope, c.type === "run_event" && c.envelope);
    first.messages.length = second.messages.length = 0;
    db.transaction(() => {
      db.update(sessions)
        .set({ title: "committed" })
        .where(eq(sessions.id, fixture.sessionId))
        .run();
      db.update(sessions)
        .set({ title: "committed together" })
        .where(eq(sessions.id, fixture.sessionId))
        .run();
      assert.equal(first.messages.length, 0);
    });
    const changes = await Promise.all([
      first.wait((m) => m.type === "state_changed"),
      second.wait((m) => m.type === "state_changed"),
    ]);
    assert.deepEqual(changes[0], changes[1]);
    assert.ok(changes[0]?.type === "state_changed" && changes[0].topics.includes("sessions"));
    assert.equal(first.messages.filter((m) => m.type === "state_changed").length, 1);
    first.send({ type: "unwatch_run", id: "a" });
    first.ws.close();
    await once(first.ws, "close");
    assert.equal(aborts, 0);
    assert.equal(runs[0]!.subscribers.size, 1);
    finishAgentRun(runs[0]!);
    await second.wait((m) => m.type === "run_close" && m.id === "c");
  } finally {
    first.ws.close();
    second.ws.close();
    for (const run of runs) if (!run.finished) finishAgentRun(run);
  }
});

test("reconnection replays the remaining events and expired replay reports a snapshot gap", async () => {
  const fixture = createSession();
  const credential = cookie(fixture.userId);
  const run = createActiveAgentRun({
    runId: randomUUID(),
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });
  const first = await connect(credential);
  try {
    emitRunEvent(run, { type: "turn_end" });
    first.send({ type: "watch_run", id: "old", runId: run.runId, after: 0 });
    await first.wait((m) => m.type === "run_event");
    first.ws.close();
    await once(first.ws, "close");
    emitRunEvent(run, { type: "agent_end" });
    const resumed = await connect(credential);
    try {
      resumed.send({ type: "watch_run", id: "new", runId: run.runId, after: 1 });
      const replay = await resumed.wait((m) => m.type === "run_event");
      assert.equal(replay.type === "run_event" && replay.envelope.sequence, 2);
      for (let i = 0; i < 1001; i++) emitRunEvent(run, { type: "turn_end" });
      resumed.send({ type: "watch_run", id: "gap", runId: run.runId, after: 0 });
      const gap = await resumed.wait((m) => m.type === "run_open" && m.id === "gap");
      assert.equal(gap.type === "run_open" && gap.status, 409);
      resumed.send({ type: "watch_run", id: "ahead", runId: run.runId, after: 100_000 });
      const ahead = await resumed.wait((m) => m.type === "run_open" && m.id === "ahead");
      assert.equal(ahead.type === "run_open" && ahead.status, 400);
      finishAgentRun(run);
      resumed.send({ type: "watch_run", id: "gone", runId: run.runId, after: 1003 });
      const gone = await resumed.wait((m) => m.type === "run_open" && m.id === "gone");
      assert.equal(gone.type === "run_open" && gone.status, 404);
    } finally {
      resumed.ws.close();
    }
  } finally {
    first.ws.close();
    if (!run.finished) finishAgentRun(run);
  }
});

test("updates reject untrusted origins, missing credentials, other users' runs and expired login", async () => {
  const fixture = createSession();
  await assert.rejects(connect(""), /401/);
  await assert.rejects(connect("carmel_session=%GG"), /401/);
  await assert.rejects(connect(cookie(fixture.userId), "https://untrusted.example"), /403/);
  const run = createActiveAgentRun({
    runId: randomUUID(),
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    abort: () => {},
  });
  const stranger = await connect(cookie(createUser()));
  const credential = cookie(fixture.userId);
  const owner = await connect(credential);
  try {
    stranger.send({ type: "watch_run", id: "private", runId: run.runId, after: 0 });
    const denied = await stranger.wait((m) => m.type === "run_open");
    assert.equal(denied.type === "run_open" && denied.status, 404);
    owner.send({ type: "watch_run", id: "owner", runId: run.runId, after: 0 });
    await owner.wait((m) => m.type === "run_open");
    const token = credential.split("=")[1]!;
    db.delete(authSessions)
      .where(eq(authSessions.tokenHash, createHash("sha256").update(token).digest("hex")))
      .run();
    const closed = once(owner.ws, "close");
    emitRunEvent(run, { type: "turn_end" });
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal(
      owner.messages.some((m) => m.type === "run_event"),
      false,
    );
    assert.equal(
      stranger.messages.some((m) => m.type === "run_event"),
      false,
    );
  } finally {
    stranger.ws.close();
    owner.ws.close();
    finishAgentRun(run);
  }
});

function cookie(userId: string) {
  const token = randomUUID();
  db.insert(authSessions)
    .values({
      id: randomUUID(),
      userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    })
    .run();
  return `carmel_session=${token}`;
}

async function connect(credential: string, requestOrigin = origin) {
  const ws = new WebSocket(`${origin.replace("http:", "ws:")}/api/updates`, {
    headers: { cookie: credential, origin: requestOrigin },
  });
  const messages: UpdateServerMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  const wait = async (
    predicate: (message: UpdateServerMessage) => boolean,
  ): Promise<UpdateServerMessage> => {
    const existing = messages.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.off("message", check);
        reject(new Error("Expected update did not arrive"));
      }, 3000);
      const check = (raw: { toString(): string }) => {
        const message = JSON.parse(raw.toString()) as UpdateServerMessage;
        if (!predicate(message)) return;
        clearTimeout(timeout);
        ws.off("message", check);
        resolve(message);
      };
      ws.on("message", check);
    });
  };
  await once(ws, "open");
  await wait((m) => m.type === "ready");
  return { ws, messages, wait, send: (message: unknown) => ws.send(JSON.stringify(message)) };
}
