import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, migrate } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { createSession, userMessage } from "../test-support.ts";
import {
  appendSessionMessages,
  loadSession,
  readSessionMessageCountsForUser,
  readSessionMessages,
  replaceSessionMessages,
} from "./session-store.ts";

migrate();

const contents = (sessionId: string) =>
  readSessionMessages(sessionId).map((message) => (message as { content: string }).content);

test("replace then read preserves message order", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  assert.deepEqual(contents(sessionId), ["a", "b", "c"]);
});

test("append writes only the tail past fromSeq and returns the new length", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b")]);

  const count = appendSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c"), userMessage("d")], 2);
  assert.equal(count, 4);
  assert.deepEqual(contents(sessionId), ["a", "b", "c", "d"]);

  // Re-appending the same range is idempotent (upsert on (session_id, seq)).
  appendSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c"), userMessage("d")], 2);
  assert.equal(readSessionMessages(sessionId).length, 4);
});

test("replace with a shorter list drops the trailing rows (truncation)", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  replaceSessionMessages(sessionId, [userMessage("a")]);
  assert.deepEqual(contents(sessionId), ["a"]);
});

test("loadSession returns the record with its messages attached", () => {
  const { sessionId, userId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("hi")]);
  const session = loadSession(sessionId);
  assert.ok(session);
  assert.equal(session.userId, userId);
  assert.equal(session.messages.length, 1);
  assert.equal(loadSession("missing"), undefined);
});

test("message counts are reported per user", () => {
  const { sessionId, userId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b")]);
  const counts = readSessionMessageCountsForUser(userId);
  assert.equal(counts.get(sessionId), 2);
});

test("deleting a session cascades to its messages", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b")]);
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  assert.equal(readSessionMessages(sessionId).length, 0);
});
