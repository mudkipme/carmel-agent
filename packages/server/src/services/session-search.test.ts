import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { createSessionRoutes } from "../routes/sessions.ts";
import { eq, sql } from "drizzle-orm";
import { db, initialize, sqlite } from "../db/index.ts";
import { agents, sessions, users } from "../db/schema.ts";
import { createSession, createUser, userMessage } from "../test-support.ts";
import { replacePiSessionMessages } from "./pi-session-storage.ts";
import { searchGlobalSessions, searchSessions, readSessionExcerpt } from "./session-search.ts";
import { readSessionSnapshot } from "./session-snapshot.ts";

initialize();
test("private retrieval verifies the active branch, excludes other users/agents, and removes deleted sources", async () => {
  const own = createSession();
  const foreign = createSession();
  await replacePiSessionMessages(own.sessionId, [
    userMessage("Earlier decision: use PostgreSQL"),
    userMessage("Recent discussion"),
  ]);
  await replacePiSessionMessages(foreign.sessionId, [userMessage("PostgreSQL private secret")]);
  const matches = await searchSessions(own.userId, own.agentId, "PostgreSQL");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.sessionId, own.sessionId);
  assert.match(matches[0]!.link, /entry=/);
  const anchored = (await readSessionSnapshot(
    own.userId,
    own.sessionId,
    undefined,
    matches[0]!.entryId,
  ))!;
  assert.equal(anchored.messageEntryIds.at(-1), matches[0]!.entryId);
  await assert.rejects(readSessionExcerpt(createUser(), own.agentId, own.sessionId), /not found/);
  await assert.rejects(readSessionExcerpt(own.userId, own.agentId, foreign.sessionId), /not found/);
  await replacePiSessionMessages(own.sessionId, [userMessage("Replacement branch")]);
  db.update(sessions)
    .set({ revision: sql`${sessions.revision} + 1` })
    .where(eq(sessions.id, own.sessionId))
    .run();
  assert.deepEqual(await searchSessions(own.userId, own.agentId, "PostgreSQL"), []);
  assert.equal(
    (await readSessionExcerpt(own.userId, own.agentId, own.sessionId, matches[0]!.entryId)).messages
      .length,
    0,
  );
  db.delete(sessions).where(eq(sessions.id, own.sessionId)).run();
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) AS n FROM session_search WHERE session_id = ?")
        .get(own.sessionId) as { n: number }
    ).n,
    0,
  );
});

test("global search finds titles and user/assistant text across agents, including archives", async () => {
  const own = createSession();
  const otherAgent = createSession({ userId: own.userId });
  db.update(sessions)
    .set({ title: "Release planning", archivedAt: Date.now(), updatedAt: Date.now() + 1000 })
    .where(eq(sessions.id, own.sessionId))
    .run();
  await replacePiSessionMessages(own.sessionId, [
    userMessage("We should ship the release next week."),
    userMessage("We should ship the release next week."),
  ]);
  await replacePiSessionMessages(otherAgent.sessionId, [
    fauxAssistantMessage("The RELEASE checklist is ready."),
    userMessage("We should ship the release next week."),
    userMessage("讨论全局搜索功能"),
    userMessage("Literal tokens: 100%_done and C++"),
  ]);
  const matches = await searchGlobalSessions(own.userId, "release");
  assert.equal(matches.length, 3);
  const title = matches.find((match) => !match.entryId)!;
  assert.equal(title.sessionId, own.sessionId);
  assert.equal(title.link, `/agents/${own.agentId}/sessions/${own.sessionId}`);
  const messages = matches.filter((match) => match.entryId);
  assert.equal(
    messages.find((match) => match.excerpt === "We should ship the release next week.")!.sessionId,
    own.sessionId,
  );
  assert.deepEqual(
    new Set(messages.map((match) => match.agentId)),
    new Set([own.agentId, otherAgent.agentId]),
  );
  for (const message of messages) {
    assert.match(message.link, /entry=/);
    const anchored = (await readSessionSnapshot(
      own.userId,
      message.sessionId,
      undefined,
      message.entryId,
    ))!;
    assert.equal(anchored.messageEntryIds.at(-1), message.entryId);
  }
  assert.equal((await searchGlobalSessions(own.userId, "lease")).length, 3);
  assert.equal((await searchGlobalSessions(own.userId, "全局搜索")).length, 1);
  assert.equal((await searchGlobalSessions(own.userId, "100%_done")).length, 1);
  assert.deepEqual(await searchGlobalSessions(own.userId, "100Xdone"), []);
  assert.equal((await searchGlobalSessions(own.userId, "C++")).length, 1);
  assert.deepEqual(await searchGlobalSessions(own.userId, "  "), []);
});

test("global search excludes thinking, tool calls, tool results and notices", async () => {
  const own = createSession();
  await replacePiSessionMessages(own.sessionId, [
    fauxAssistantMessage(
      [
        { type: "thinking", thinking: "Hidden reasoningneedle" },
        fauxToolCall("toolneedle", { command: "argumentneedle" }),
        { type: "text", text: "Visible answerneedle" },
      ],
      { stopReason: "toolUse" },
    ),
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "toolneedle",
      content: [{ type: "text", text: "resultneedle" }],
      isError: false,
      timestamp: Date.now(),
    },
    { role: "homeNotice", text: "noticeneedle", timestamp: Date.now() },
  ]);
  for (const query of [
    "reasoningneedle",
    "toolneedle",
    "argumentneedle",
    "resultneedle",
    "noticeneedle",
  ]) {
    assert.deepEqual(await searchGlobalSessions(own.userId, query), []);
  }
  const matches = await searchGlobalSessions(own.userId, "answerneedle");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.excerpt, "Visible answerneedle");
});

test("global search excludes other users and agents that are no longer visible, and refreshes edited history", async () => {
  const own = createSession();
  const foreign = createSession();
  const shared = createSession({ userId: foreign.userId });
  db.update(agents).set({ shared: true }).where(eq(agents.id, shared.agentId)).run();
  await replacePiSessionMessages(foreign.sessionId, [userMessage("privacyneedle foreign")]);
  await replacePiSessionMessages(shared.sessionId, [
    userMessage("privacyneedle shared agent foreign"),
  ]);
  db.update(sessions)
    .set({ title: "privacyneedle title" })
    .where(eq(sessions.id, foreign.sessionId))
    .run();
  await replacePiSessionMessages(own.sessionId, [userMessage("privacyneedle own")]);
  assert.deepEqual(
    (await searchGlobalSessions(own.userId, "privacyneedle")).map((match) => match.sessionId),
    [own.sessionId],
  );
  await replacePiSessionMessages(own.sessionId, [userMessage("Replacement branch")]);
  db.update(sessions)
    .set({ revision: sql`${sessions.revision} + 1` })
    .where(eq(sessions.id, own.sessionId))
    .run();
  assert.deepEqual(await searchGlobalSessions(own.userId, "privacyneedle"), []);
  db.update(agents)
    .set({ ownerUserId: foreign.userId, shared: false })
    .where(eq(agents.id, own.agentId))
    .run();
  assert.deepEqual(await searchGlobalSessions(own.userId, "Replacement"), []);
});

test("global search API validates queries and searches as the signed-in user", async () => {
  const own = createSession();
  const foreign = createSession();
  await replacePiSessionMessages(own.sessionId, [
    ...Array.from({ length: 55 }, () => userMessage("route match: C++")),
    userMessage("Another route match: C++"),
  ]);
  await replacePiSessionMessages(foreign.sessionId, [userMessage("route match: C++ private")]);
  const user = db.select().from(users).where(eq(users.id, own.userId)).get()!;
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createSessionRoutes());
  const response = await app.request(`/sessions/search?${new URLSearchParams({ q: "C++" })}`);
  assert.equal(response.status, 200);
  const matches = (await response.json()) as Array<{ sessionId: string }>;
  assert.deepEqual(
    matches.map((match) => match.sessionId),
    [own.sessionId, own.sessionId],
  );
  assert.deepEqual(await (await app.request("/sessions/search")).json(), []);
  const tooLong = await app.request(`/sessions/search?q=${"a".repeat(501)}`);
  assert.equal(tooLong.status, 400);
});
