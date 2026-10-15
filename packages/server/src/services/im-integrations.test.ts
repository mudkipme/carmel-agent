import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { agents, sessions, users } from "../db/schema.ts";
import {
  imBindings,
  imCredentials,
  imInbox,
  imIntegrations,
  imOutbox,
  imSetups,
} from "../db/im-schema.ts";
import { createAgent, createModelRef, createUser } from "../test-support.ts";
import {
  beginImConnect,
  beginImQr,
  completeImPair,
  deleteImIntegration,
  enqueueImMessage,
  finishSetup,
  listImIntegrations,
  listImSetups,
  ownedSetup,
  pollImQr,
  resolveNotificationIntegration,
  serializeImSetup,
  setupState,
  updateImIntegration,
} from "./im-integrations.ts";
import { createImIntegrationRoutes } from "../routes/im-integrations.ts";
import { ImManager, receiveImMessage, recoverImWork } from "../runtime/im-manager.ts";
import { ImProviderError, type ImTransport } from "../im/platform.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";
import { createAgentTask, readAgentTask } from "./agent-tasks.ts";
import { createSendUserMessageTool } from "../runtime/im-tools.ts";
import { executeNativeTool } from "../effectors/testing/tools.ts";

initialize();
const originalFetch = globalThis.fetch;
const originalKey = process.env.CARMEL_SECRET_KEY;
let nextBot = 1000;
const json = (value: unknown) => Response.json(value);
beforeEach(() => {
  process.env.CARMEL_SECRET_KEY = "im-test-key";
  db.delete(imIntegrations).run();
  db.delete(imSetups).run();
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/getMe")) {
      const botId = Number(/bot(\d+):/.exec(url)?.[1]);
      return json({ ok: true, result: { id: botId, username: `bot_${botId}` } });
    }
    if (url.endsWith("/getWebhookInfo")) return json({ ok: true, result: { url: "" } });
    throw new Error("Unexpected request.");
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.CARMEL_SECRET_KEY;
  else process.env.CARMEL_SECRET_KEY = originalKey;
});
function fixture() {
  const userId = createUser();
  const modelRefId = createModelRef({ ownerUserId: userId });
  const agentId = createAgent({ ownerUserId: userId, defaultModelRefId: modelRefId, shared: true });
  return { userId, agentId, modelRefId };
}
async function paired(f = fixture()) {
  const botId = nextBot++;
  const token = `${botId}:test_secret`;
  const setup = await beginImConnect(f.userId, f.agentId, "telegram", { token });
  const integrationId = completeImPair(setup.id, {
    eventId: "pair",
    senderId: "person-1",
    chatId: "chat-1",
    text: setup.pairCommand!,
    imageKeys: [],
  })!;
  db.delete(imOutbox).where(eq(imOutbox.integrationId, integrationId)).run();
  return { ...f, integrationId, botId, token };
}
function incoming(text = "Hello", eventId = "event-1") {
  return { eventId, senderId: "person-1", chatId: "chat-1", text, imageKeys: [] };
}
function appFor(userId: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const user = db.select().from(users).where(eq(users.id, userId)).get()!;
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createImIntegrationRoutes());
  return app;
}
test("setup encrypts credentials and only an unexpired one-time private pairing command admits a sender", async () => {
  const f = fixture();
  const setup = await beginImConnect(f.userId, f.agentId, "telegram", { token: "101:test_secret" });
  assert.equal(setup.status, "pairing");
  assert.match(setup.botUrl!, /^https:\/\/t.me\/bot_101\?start=/);
  const raw = db.select().from(imSetups).where(eq(imSetups.id, setup.id)).get()!;
  assert.ok(raw.state.startsWith("enc:v1:"));
  assert.ok(!raw.state.includes("test_secret"));
  assert.ok(!JSON.stringify(setup).includes("test_secret"));
  assert.equal(completeImPair(setup.id, incoming("/pair incorrect")), undefined);
  const integrationId = completeImPair(setup.id, incoming(setup.pairCommand!));
  assert.ok(integrationId);
  assert.equal(completeImPair(setup.id, incoming(setup.pairCommand!)), undefined);
  assert.deepEqual(
    listImIntegrations(f.userId, f.agentId).map((item) => item.senderId),
    ["person-1"],
  );
  assert.ok(
    db
      .select()
      .from(imCredentials)
      .where(eq(imCredentials.integrationId, integrationId))
      .get()!
      .value.startsWith("enc:v1:"),
  );
  assert.equal(db.select().from(imSetups).where(eq(imSetups.id, setup.id)).get()!.state, "{}");
});
test("shared agent integrations remain private to each user, including API reads and mutations by admins", async () => {
  const f = await paired();
  const otherId = createUser();
  db.update(users).set({ role: "admin" }).where(eq(users.id, otherId)).run();
  const other = appFor(otherId);
  const base = `/agents/${f.agentId}/integrations`;
  assert.deepEqual(await (await other.request(base)).json(), []);
  assert.equal(
    (await other.request(`${base}/${f.integrationId}`, { method: "DELETE" })).status,
    404,
  );
  assert.equal(
    (
      await other.request(`${base}/${f.integrationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      })
    ).status,
    404,
  );
  await assert.rejects(
    beginImConnect(otherId, f.agentId, "telegram", { token: f.token }),
    /already assigned/,
  );
  const own = await (await appFor(f.userId).request(base)).text();
  assert.ok(!own.includes(f.token));
  assert.ok(!own.includes("enc:v1:"));
  assert.throws(() => resolveNotificationIntegration(otherId, f.agentId), /No enabled/);
});
test("setup refuses plaintext storage, rejects expired pairing, and cancellation clears registration secrets", async () => {
  const f = fixture();
  delete process.env.CARMEL_SECRET_KEY;
  await assert.rejects(
    beginImConnect(f.userId, f.agentId, "telegram", { token: "102:test_secret" }),
    /CARMEL_SECRET_KEY/,
  );
  process.env.CARMEL_SECRET_KEY = "im-test-key";
  const setup = await beginImConnect(f.userId, f.agentId, "telegram", { token: "102:test_secret" });
  db.update(imSetups)
    .set({ expiresAt: Date.now() - 1 })
    .where(eq(imSetups.id, setup.id))
    .run();
  assert.equal(completeImPair(setup.id, incoming(setup.pairCommand!)), undefined);
  assert.equal(ownedSetup(f.userId, f.agentId, setup.id).status, "expired");
  const next = await beginImConnect(f.userId, f.agentId, "telegram", { token: "103:test_secret" });
  finishSetup(next.id, "cancelled");
  assert.equal(serializeImSetup(ownedSetup(f.userId, f.agentId, next.id)).pairCommand, undefined);
  assert.equal(completeImPair(next.id, incoming(next.pairCommand!)), undefined);
});
test("replacing a bot is staged, same-bot credential rotation preserves its sender and session, and disconnect keeps history", async () => {
  const f = await paired();
  const sessionId = "im_preserved_session";
  db.insert(sessions)
    .values({
      id: sessionId,
      userId: f.userId,
      agentId: f.agentId,
      modelRefId: f.modelRefId,
      title: "IM history",
      thinkingLevel: "off",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.update(imBindings)
    .set({ sessionId })
    .where(eq(imBindings.integrationId, f.integrationId))
    .run();
  const replacement = await beginImConnect(f.userId, f.agentId, "telegram", {
    token: "104:new_secret",
  });
  assert.equal(listImIntegrations(f.userId, f.agentId)[0].botId, String(f.botId));
  finishSetup(replacement.id, "cancelled");
  const rotated = await beginImConnect(f.userId, f.agentId, "telegram", {
    token: `${f.botId}:rotated_secret`,
  });
  assert.equal(rotated.status, "completed");
  assert.equal(listImIntegrations(f.userId, f.agentId)[0].sessionId, sessionId);
  deleteImIntegration(f.userId, f.agentId, f.integrationId);
  assert.equal(db.select().from(imCredentials).all().length, 0);
  assert.ok(db.select().from(sessions).where(eq(sessions.id, sessionId)).get());
});
test("QR registration follows pending, slow_down and Lark switching without exposing device codes or app secrets", async () => {
  const f = fixture();
  const requests: Array<{ url: string; action?: string }> = [];
  let poll = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const action = new URLSearchParams(String(init?.body)).get("action") ?? undefined;
    requests.push({ url, action });
    if (action === "init") return json({ supported_auth_methods: ["client_secret"] });
    if (action === "begin")
      return json({
        device_code: "device_private",
        verification_uri_complete: "https://accounts.feishu.cn/verify?token=verification",
        interval: 5,
        expire_in: 600,
      });
    if (action === "poll") {
      poll++;
      if (poll === 1) return json({ error: "authorization_pending" });
      if (poll === 2) return json({ error: "slow_down" });
      if (poll === 3) return json({ user_info: { tenant_brand: "lark" } });
      return json({
        client_id: "cli_lark",
        client_secret: "app_private",
        user_info: { tenant_brand: "lark", open_id: "bot_not_person" },
      });
    }
    if (url.endsWith("/tenant_access_token/internal"))
      return json({ code: 0, tenant_access_token: "tenant_private", expire: 7200 });
    if (url.endsWith("/bot/v3/info"))
      return json({ code: 0, bot: { open_id: "bot_not_person", bot_name: "Lark bot" } });
    throw new Error("Unexpected request.");
  };
  const setup = await beginImQr(f.userId, f.agentId, "lark");
  assert.ok(setup.qrDataUrl?.startsWith("data:image/png;base64,"));
  const read = () => db.select().from(imSetups).where(eq(imSetups.id, setup.id)).get()!;
  await pollImQr(read());
  assert.equal(read().status, "authorizing");
  await pollImQr(read());
  assert.equal(read().interval, 10_000);
  await pollImQr(read());
  assert.equal(setupState(read()).region, "lark");
  await pollImQr(read());
  assert.equal(read().status, "pairing");
  const publicSetup = serializeImSetup(read());
  for (const secret of ["device_private", "app_private", "tenant_private", "bot_not_person"])
    assert.ok(!JSON.stringify(publicSetup).includes(secret));
  assert.equal(publicSetup.platform, "lark");
  assert.ok(
    requests
      .filter((item) => item.action === "poll")
      .at(-1)!
      .url.startsWith("https://accounts.larksuite.com/"),
  );
  assert.deepEqual(listImIntegrations(f.userId, f.agentId), []);
  assert.ok(completeImPair(setup.id, incoming(publicSetup.pairCommand!)));
  assert.equal(listImIntegrations(f.userId, f.agentId)[0].senderId, "person-1");
});
test("a QR response arriving after cancellation cannot install credentials", async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  globalThis.fetch = async (_input, init) => {
    const action = new URLSearchParams(String(init?.body)).get("action");
    if (action === "init") return json({});
    if (action === "begin")
      return json({
        device_code: "device",
        verification_uri_complete: "https://accounts.feishu.cn/verify",
        expire_in: 600,
      });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return json({ client_id: "cli_late", client_secret: "late_secret" });
  };
  const setup = await beginImQr(f.userId, f.agentId, "feishu");
  const row = ownedSetup(f.userId, f.agentId, setup.id);
  const pending = pollImQr(row);
  await new Promise((resolve) => setImmediate(resolve));
  finishSetup(setup.id, "cancelled");
  release!();
  await pending;
  assert.equal(ownedSetup(f.userId, f.agentId, setup.id).status, "cancelled");
  assert.deepEqual(listImIntegrations(f.userId, f.agentId), []);
});

test("QR-created credentials are retained while publishing or bot permissions still need attention", async () => {
  const f = fixture();
  globalThis.fetch = async (input, init) => {
    const action = new URLSearchParams(String(init?.body)).get("action");
    if (action === "init") return json({});
    if (action === "begin")
      return json({
        device_code: "device",
        verification_uri_complete: "https://accounts.feishu.cn/verify",
        expire_in: 600,
      });
    if (action === "poll")
      return json({ client_id: "cli_not_published", client_secret: "created_app_secret" });
    if (String(input).endsWith("tenant_access_token/internal"))
      return json({ code: 0, tenant_access_token: "token" });
    return json({ code: 9999 });
  };
  const setup = await beginImQr(f.userId, f.agentId, "feishu");
  await pollImQr(ownedSetup(f.userId, f.agentId, setup.id));
  const row = ownedSetup(f.userId, f.agentId, setup.id);
  assert.equal(row.status, "pairing");
  assert.equal(setupState(row).credential?.appSecret, "created_app_secret");
  const visible = serializeImSetup(row);
  assert.match(visible.error!, /Bot created/);
  assert.ok(!JSON.stringify(visible).includes("created_app_secret"));
});

test("a delayed delivery blocks later messages, and disabling during a multi-part send cancels the remaining chunks", async () => {
  const f = await paired();
  const first = enqueueImMessage(f.integrationId, "First", "ordered-first", true);
  enqueueImMessage(f.integrationId, "Second", "ordered-second", true);
  db.update(imOutbox)
    .set({ nextAttemptAt: Date.now() + 60_000 })
    .where(eq(imOutbox.id, first.id))
    .run();
  let sends = 0;
  let release: ((id: string) => void) | undefined;
  const manager = new ImManager(() => ({
    async start() {},
    stop() {},
    async image() {
      throw new Error();
    },
    async send() {
      sends++;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    },
  }));
  try {
    await manager.tick();
    await manager.drain();
    assert.equal(sends, 0);
    db.delete(imOutbox).run();
    const multi = enqueueImMessage(f.integrationId, "x".repeat(7000), "multi", true);
    await manager.tick();
    assert.equal(sends, 1);
    updateImIntegration(f.userId, f.agentId, f.integrationId, { proactive: false });
    release!("first-part");
    await manager.drain();
    assert.equal(sends, 1);
    assert.equal(
      db.select().from(imOutbox).where(eq(imOutbox.id, multi.id)).get()!.status,
      "cancelled",
    );
    updateImIntegration(f.userId, f.agentId, f.integrationId, { proactive: true });
    await manager.tick();
    await manager.drain();
    assert.equal(sends, 1);
  } finally {
    manager.stop();
  }
});
test("inbound dedup and sender binding reject strangers, while stop cancels the run and queued messages", async () => {
  const f = await paired();
  await receiveImMessage(f.integrationId, { ...incoming(), senderId: "stranger" });
  await receiveImMessage(f.integrationId, { ...incoming(), chatId: "other-chat" });
  assert.equal(db.select().from(imInbox).all().length, 0);
  await receiveImMessage(f.integrationId, incoming());
  await receiveImMessage(f.integrationId, incoming());
  assert.equal(db.select().from(imInbox).all().length, 1);
  const sessionId = "im_stop_session";
  db.update(imBindings)
    .set({ sessionId })
    .where(eq(imBindings.integrationId, f.integrationId))
    .run();
  let stopped = false;
  const run = createActiveAgentRun({
    runId: "im_stop_run",
    userId: f.userId,
    sessionId,
    abort: () => {
      stopped = true;
    },
  });
  try {
    await receiveImMessage(f.integrationId, incoming("/new", "new"));
    assert.equal(
      db.select().from(imBindings).where(eq(imBindings.integrationId, f.integrationId)).get()!
        .sessionId,
      sessionId,
    );
    await receiveImMessage(f.integrationId, incoming("/stop", "stop"));
    assert.equal(stopped, true);
    assert.equal(db.select().from(imInbox).where(eq(imInbox.status, "queued")).all().length, 0);
  } finally {
    finishAgentRun(run);
  }
});
test("proactive tool routes by the run owner, rejects arbitrary recipients, and records scheduled notification destinations", async () => {
  const f = await paired();
  const sessionId = "task-notification-session";
  const tool = createSendUserMessageTool({ userId: f.userId, agentId: f.agentId, sessionId });
  const result = await executeNativeTool(tool, { text: "Build failed.", platform: "telegram" });
  assert.equal(result.isError, false);
  const [delivery] = db.select().from(imOutbox).all();
  assert.equal(delivery.integrationId, f.integrationId);
  assert.equal(delivery.sessionId, sessionId);
  assert.equal(delivery.proactive, true);
  const rejected = await executeNativeTool(tool, {
    text: "Wrong recipient",
    userId: "another-person",
  });
  assert.equal(rejected.isError, true);
  assert.equal(db.select().from(imOutbox).all().length, 1);
  const task = createAgentTask({ id: f.userId, role: "user" }, f.agentId, {
    name: "Check build",
    prompt: "Notify only on failure",
    scheduleKind: "interval",
    scheduleValue: "60000",
    notifyPlatform: "telegram",
  });
  assert.equal(
    readAgentTask({ id: f.userId, role: "user" }, f.agentId, task.id).notifyPlatform,
    "telegram",
  );
  updateImIntegration(f.userId, f.agentId, f.integrationId, { proactive: false });
  await assert.rejects(executeNativeTool(tool, { text: "Disabled" }), /No enabled/);
  assert.equal(db.select().from(imOutbox).all()[0].status, "cancelled");
});
test("delivery retries explicit rate limits without replaying prompts and preserves ambiguous sends", async () => {
  const f = await paired();
  let calls = 0;
  const transport: ImTransport = {
    async start() {},
    stop() {},
    async image() {
      throw new Error();
    },
    async send() {
      calls++;
      if (calls === 1) throw new ImProviderError("Rate limited.", 1000);
      return "sent-message";
    },
  };
  const manager = new ImManager(() => transport);
  try {
    const message = enqueueImMessage(f.integrationId, "Alert", "rate-limit", true);
    await manager.tick();
    await manager.drain();
    assert.equal(calls, 1);
    assert.equal(
      db.select().from(imOutbox).where(eq(imOutbox.id, message.id)).get()!.status,
      "pending",
    );
    db.update(imOutbox).set({ nextAttemptAt: 0 }).where(eq(imOutbox.id, message.id)).run();
    await manager.tick();
    await manager.drain();
    assert.equal(calls, 2);
    assert.equal(
      db.select().from(imOutbox).where(eq(imOutbox.id, message.id)).get()!.status,
      "sent",
    );
    assert.equal(db.select().from(imInbox).all().length, 0);
    enqueueImMessage(f.integrationId, "Uncertain", "ambiguous", true);
    transport.send = async () => {
      calls++;
      throw new ImProviderError("Connection lost.", undefined, true);
    };
    await manager.tick();
    await manager.drain();
    assert.equal(
      db.select().from(imOutbox).where(eq(imOutbox.status, "uncertain")).all().length,
      1,
    );
    const sent = calls;
    await manager.tick();
    await manager.drain();
    assert.equal(calls, sent);
  } finally {
    manager.stop();
  }
});
test("revoking shared agent access cancels pending delivery and disconnecting cascades all integration records", async () => {
  const f = await paired();
  const otherId = createUser();
  const other = await paired({ ...f, userId: otherId });
  enqueueImMessage(other.integrationId, "Private result", "revoked", true);
  db.update(agents).set({ shared: false }).where(eq(agents.id, f.agentId)).run();
  let calls = 0;
  const manager = new ImManager(() => ({
    async start() {},
    stop() {},
    async send() {
      calls++;
      return "sent";
    },
    async image() {
      throw new Error();
    },
  }));
  try {
    await manager.tick();
    await manager.drain();
    assert.equal(calls, 0);
    assert.equal(
      db.select().from(imIntegrations).where(eq(imIntegrations.id, other.integrationId)).get()!
        .enabled,
      false,
    );
    assert.equal(db.select().from(imOutbox).all()[0].status, "cancelled");
    db.delete(users).where(eq(users.id, otherId)).run();
    assert.equal(
      db
        .select()
        .from(imCredentials)
        .where(eq(imCredentials.integrationId, other.integrationId))
        .get(),
      undefined,
    );
  } finally {
    manager.stop();
  }
});
test("startup never replays an admitted turn or blindly repeats a send whose result was lost", async () => {
  const f = await paired();
  await receiveImMessage(f.integrationId, incoming());
  db.update(imInbox).set({ status: "running" }).run();
  const delivery = enqueueImMessage(f.integrationId, "Possible duplicate", "restart", true);
  db.update(imOutbox).set({ status: "sending" }).where(eq(imOutbox.id, delivery.id)).run();
  recoverImWork();
  recoverImWork();
  assert.equal(db.select().from(imInbox).all()[0].status, "interrupted");
  assert.equal(
    db.select().from(imOutbox).where(eq(imOutbox.id, delivery.id)).get()!.status,
    "uncertain",
  );
  assert.equal(db.select().from(imOutbox).where(eq(imOutbox.proactive, false)).all().length, 1);
});
test("tool enqueue keys stay idempotent across retries", async () => {
  const f = await paired();
  const first = enqueueImMessage(f.integrationId, "First", "tool:conversation:call", true);
  const replay = enqueueImMessage(f.integrationId, "First", "tool:conversation:call", true);
  assert.equal(first.id, replay.id);
  assert.equal(db.select().from(imOutbox).all().length, 1);
  assert.equal(listImSetups(f.userId, f.agentId).length, 0);
});
