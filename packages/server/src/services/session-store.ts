import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessionMessages, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";

type SessionRecord = typeof sessions.$inferSelect;
export type SessionWithMessages = SessionRecord & { messages: AgentMessage[] };

export function readSessionMessages(sessionId: string): AgentMessage[] {
  return db
    .select({ message: sessionMessages.message })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(asc(sessionMessages.seq))
    .all()
    .map((row) => row.message);
}

function attachMessages(record: SessionRecord): SessionWithMessages {
  return { ...record, messages: readSessionMessages(record.id) };
}

// Fetch a single message by its position without materializing the whole
// transcript. `seq` equals the message's array index (see replaceSessionMessages).
export function readSessionMessageAt(sessionId: string, seq: number): AgentMessage | undefined {
  if (!Number.isInteger(seq) || seq < 0) return undefined;
  const row = db
    .select({ message: sessionMessages.message })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.seq, seq)))
    .get();
  return row?.message;
}

export function loadSession(sessionId: string): SessionWithMessages | undefined {
  const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  return record ? attachMessages(record) : undefined;
}

// Authoritative write: the row set is made to exactly match `messages`. Used for
// edits, forks, truncation, import, and the run-end reconcile.
export function replaceSessionMessages(sessionId: string, messages: AgentMessage[]) {
  const timestamp = now();
  db.transaction((tx) => {
    tx.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).run();
    if (messages.length === 0) return;
    tx.insert(sessionMessages)
      .values(
        messages.map((message, seq) => ({
          id: id("session_message"),
          sessionId,
          seq,
          message,
          createdAt: timestamp,
        })),
      )
      .run();
  });
}

// Incremental append used during a run: inserts only the messages added since
// `fromSeq`, so a checkpoint is O(new messages) rather than O(whole history).
// During a run the message list only grows (compaction is disabled), so seqs
// never collide; the run-end replace is the authoritative reconcile.
export function appendSessionMessages(sessionId: string, messages: AgentMessage[], fromSeq: number): number {
  if (messages.length <= fromSeq) return fromSeq;
  const timestamp = now();
  db.insert(sessionMessages)
    .values(
      messages.slice(fromSeq).map((message, offset) => ({
        id: id("session_message"),
        sessionId,
        seq: fromSeq + offset,
        message,
        createdAt: timestamp,
      })),
    )
    // Idempotent on (session_id, seq): a retried checkpoint or a stale fromSeq
    // overwrites with the same content rather than failing on the unique index.
    .onConflictDoUpdate({
      target: [sessionMessages.sessionId, sessionMessages.seq],
      set: { message: sql`excluded.message`, createdAt: sql`excluded.created_at` },
    })
    .run();
  return messages.length;
}

export function readSessionMessageCountsForUser(userId: string): Map<string, number> {
  const rows = db
    .select({ sessionId: sessionMessages.sessionId, count: sql<number>`count(*)` })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .where(eq(sessions.userId, userId))
    .groupBy(sessionMessages.sessionId)
    .all();
  return new Map(rows.map((row) => [row.sessionId, Number(row.count)]));
}
