import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { loadSession, replaceSessionMessages } from "../services/session-store.ts";
import { createSession, userMessage } from "../test-support.ts";
import { createSessionRoutes } from "./sessions.ts";

migrate();
const json = { "content-type": "application/json" };

test("session routes fork, edit, and truncate by native Pi entry ID", async () => {
  const fixture = createSession();
  await replaceSessionMessages(fixture.sessionId, [
    userMessage("question"),
    fauxAssistantMessage("answer"),
    userMessage("follow-up"),
  ]);
  const source = await loadSession(fixture.sessionId);
  assert.ok(source);
  const [questionId, answerId] = source.messageEntryIds;
  assert.ok(questionId && answerId);
  const app = createTestApp(fixture.userId);

  const forkResponse = await app.request(`/sessions/${fixture.sessionId}/fork`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ entryId: answerId }),
  });
  assert.equal(forkResponse.status, 201);
  const fork = await forkResponse.json() as typeof source;
  assert.deepEqual(fork.messages.map(messageText), ["question", "answer"]);
  assert.deepEqual(fork.messageEntryIds, [questionId, answerId]);
  assert.deepEqual(fork.forkedFrom, { sessionId: fixture.sessionId, entryId: answerId });

  const editResponse = await app.request(
    `/sessions/${fixture.sessionId}/messages/${encodeURIComponent(answerId)}`,
    { method: "PATCH", headers: json, body: JSON.stringify({ content: "edited answer" }) },
  );
  assert.equal(editResponse.status, 200);
  const edited = await editResponse.json() as typeof source;
  assert.deepEqual(edited.messages.map(messageText), ["question", "edited answer", "follow-up"]);
  assert.equal(edited.messageEntryIds[0], questionId);
  assert.notEqual(edited.messageEntryIds[1], answerId);
  assert.notEqual(edited.messageEntryIds[2], source.messageEntryIds[2]);

  const truncateResponse = await app.request(`/sessions/${fixture.sessionId}/messages/truncate`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ entryId: edited.messageEntryIds[1] }),
  });
  assert.equal(truncateResponse.status, 200);
  const truncated = await truncateResponse.json() as typeof source;
  assert.deepEqual(truncated.messages.map(messageText), ["question", "edited answer"]);
  assert.deepEqual(truncated.messageEntryIds, edited.messageEntryIds.slice(0, 2));
});

function createTestApp(userId: string) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  assert.ok(user);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", createSessionRoutes());
  return app;
}

function messageText(message: unknown) {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part),
    )
    .map((part) => part.text)
    .join("\n");
}
