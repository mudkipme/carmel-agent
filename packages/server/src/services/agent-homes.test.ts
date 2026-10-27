import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, initialize } from "../db/index.ts";
import { agents, modelRefs, sessions, users } from "../db/schema.ts";
import { imBindings, imIntegrations } from "../db/im-schema.ts";
import { createProviderConfig, createSession, createUser, userMessage } from "../test-support.ts";
import { ensureHome, resetHome } from "./agent-homes.ts";
import { replacePiSessionMessages } from "./pi-session-storage.ts";
import { readSessionSnapshot } from "./session-snapshot.ts";
import { createSessionRoutes } from "../routes/sessions.ts";
import type { AuthVariables } from "../auth.ts";

initialize();

test("Home adopts a shared agent's existing IM session without access to its default model", async () => {
  const owner = createSession();
  const recipient = createSession();
  db.update(agents).set({ shared: true }).where(eq(agents.id, owner.agentId)).run();
  db.update(modelRefs)
    .set({ providerConfigId: createProviderConfig(owner.userId) })
    .where(eq(modelRefs.id, owner.modelRefId))
    .run();
  db.update(sessions)
    .set({ agentId: owner.agentId, thinkingLevel: "high" })
    .where(eq(sessions.id, recipient.sessionId))
    .run();
  await replacePiSessionMessages(recipient.sessionId, [userMessage("Existing IM history")]);
  assert.throws(() => ensureHome(recipient.userId, owner.agentId), /available default model/);
  const integrationId = crypto.randomUUID();
  db.insert(imIntegrations)
    .values({
      id: integrationId,
      userId: recipient.userId,
      agentId: owner.agentId,
      platform: "telegram",
      botId: integrationId,
      botName: "Shared agent",
      status: "connected",
      updatedAt: Date.now(),
    })
    .run();
  db.insert(imBindings)
    .values({
      integrationId,
      senderId: "person",
      chatId: "private",
      sessionId: recipient.sessionId,
    })
    .run();
  const home = ensureHome(recipient.userId, owner.agentId);
  assert.equal(home.sessionId, recipient.sessionId);
  const session = (await readSessionSnapshot(recipient.userId, home.sessionId))!;
  assert.equal(session.modelRefId, recipient.modelRefId);
  assert.equal(session.thinkingLevel, "high");
  assert.equal(session.messages[0]?.role, "user");
  assert.equal(ensureHome(recipient.userId, owner.agentId).sessionId, home.sessionId);
});

test("Home is stable, private per user, and protected from ordinary archive/delete", async () => {
  const fixture = createSession();
  db.update(agents).set({ shared: true }).where(eq(agents.id, fixture.agentId)).run();
  const first = ensureHome(fixture.userId, fixture.agentId);
  assert.equal(ensureHome(fixture.userId, fixture.agentId).sessionId, first.sessionId);
  const second = ensureHome(createUser(), fixture.agentId);
  assert.notEqual(second.sessionId, first.sessionId);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", db.select().from(users).where(eq(users.id, fixture.userId)).get()!);
    await next();
  });
  app.route("/", createSessionRoutes());
  assert.equal(
    (await app.request(`/sessions/${first.sessionId}`, { method: "DELETE" })).status,
    409,
  );
  assert.equal(
    (
      await app.request(`/sessions/${first.sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archivedAt: Date.now() }),
      })
    ).status,
    409,
  );
});

test("history pages have no gaps and reset preserves readable history", async () => {
  const fixture = createSession();
  const home = ensureHome(fixture.userId, fixture.agentId);
  await replacePiSessionMessages(
    home.sessionId,
    Array.from({ length: 245 }, (_, i) => userMessage(`message ${i}`)),
  );
  let page = await readSessionSnapshot(fixture.userId, home.sessionId);
  assert.ok(page);
  assert.ok(page.olderCursor);
  const ids = [...page.messageEntryIds];
  while (page.olderCursor) {
    page = (await readSessionSnapshot(fixture.userId, home.sessionId, page.olderCursor))!;
    ids.unshift(...page.messageEntryIds);
  }
  assert.equal(ids.length, 245);
  assert.equal(new Set(ids).size, 245);
  assert.equal(await readSessionSnapshot(createUser(), home.sessionId), undefined);
  await resetHome(fixture.userId, fixture.agentId);
  const reset = (await readSessionSnapshot(fixture.userId, home.sessionId))!;
  assert.ok(reset.messages.some((message) => message.role === "user"));
  assert.equal(reset.messages.at(-1)?.role, "homeNotice");
});
