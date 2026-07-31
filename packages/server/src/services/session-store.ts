import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { readActivePiSessionBranch, replacePiSessionMessages } from "./pi-session-storage.ts";

type SessionRecord = typeof sessions.$inferSelect;
export type SessionWithMessages = SessionRecord & { messages: AgentMessage[] };

export function readSessionMessages(sessionId: string): AgentMessage[] {
  return readActivePiSessionBranch(sessionId).flatMap((entry) =>
    entry.type === "message" ? [entry.message] : [],
  );
}

function attachMessages(record: SessionRecord): SessionWithMessages {
  return { ...record, messages: readSessionMessages(record.id) };
}

export function readSessionMessageAt(sessionId: string, index: number): AgentMessage | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  return readSessionMessages(sessionId)[index];
}

export function loadSession(sessionId: string): SessionWithMessages | undefined {
  const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  return record ? attachMessages(record) : undefined;
}

/**
 * Move the active conversation to a new linear branch containing `messages`.
 * Existing Pi entries are immutable and retained for rollback/tree navigation.
 */
export function replaceSessionMessages(sessionId: string, messages: AgentMessage[]) {
  replacePiSessionMessages(sessionId, messages);
}

export function readSessionMessageCountsForUser(userId: string): Map<string, number> {
  const records = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .all();
  return new Map(records.map((record) => [record.id, readSessionMessages(record.id).length]));
}
