import test from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db, initialize, sqlite } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { createSession, createUser, userMessage } from "../test-support.ts";
import { replacePiSessionMessages } from "./pi-session-storage.ts";
import { searchSessions, readSessionExcerpt } from "./session-search.ts";
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
