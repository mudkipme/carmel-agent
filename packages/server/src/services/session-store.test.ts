import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, migrate } from "../db/index.ts";
import { sessionMessages, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createSession, userMessage } from "../test-support.ts";
import {
  appendSessionMessages,
  loadSession,
  readSessionMessageAt,
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

test("readSessionMessageAt returns one message by index without loading the rest", () => {
  const { sessionId } = createSession();
  replaceSessionMessages(sessionId, [userMessage("a"), userMessage("b"), userMessage("c")]);
  assert.equal((readSessionMessageAt(sessionId, 1) as { content: string }).content, "b");
  assert.equal(readSessionMessageAt(sessionId, 3), undefined);
  assert.equal(readSessionMessageAt(sessionId, -1), undefined);
});

test("readSessionMessageAt addresses by array position even when seqs have gaps", () => {
  // A missing seq (e.g. a message lost to a persistence race) must not shift a
  // message off the index the serializer bakes into its image URLs. Index N must
  // always resolve to the Nth message readSessionMessages returns, gap or not.
  const { sessionId } = createSession();
  const timestamp = now();
  const rows = [
    { seq: 0, content: "a" },
    { seq: 1, content: "b" },
    // seq 2 intentionally absent.
    { seq: 3, content: "c" },
    { seq: 4, content: "d" },
  ];
  db.insert(sessionMessages)
    .values(rows.map((row) => ({ id: id("session_message"), sessionId, seq: row.seq, message: userMessage(row.content), createdAt: timestamp })))
    .run();

  assert.deepEqual(contents(sessionId), ["a", "b", "c", "d"]);
  // Positions stay aligned with readSessionMessages across the gap.
  assert.equal((readSessionMessageAt(sessionId, 2) as { content: string }).content, "c");
  assert.equal((readSessionMessageAt(sessionId, 3) as { content: string }).content, "d");
  assert.equal(readSessionMessageAt(sessionId, 4), undefined);
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
