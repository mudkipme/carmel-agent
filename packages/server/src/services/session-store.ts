import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { readPiSessionBranch, readPiSessionPage, withPiSession } from "./pi-session-storage.ts";

type SessionRecord = typeof sessions.$inferSelect;
export type SessionMessageEntry = { entryId: string; message: AgentMessage };
export type SessionWithMessages = SessionRecord & {
  messages: AgentMessage[];
  messageEntryIds: string[];
  olderCursor?: string;
};

export async function readSessionMessageEntries(sessionId: string): Promise<SessionMessageEntry[]> {
  return withPiSession(sessionId, async (session) =>
    (await readPiSessionBranch(session)).flatMap((entry) =>
      entry.type === "message" ? [{ entryId: entry.id, message: entry.message }] : [],
    ),
  );
}

export async function readSessionMessages(sessionId: string): Promise<AgentMessage[]> {
  return (await readSessionMessageEntries(sessionId)).map((entry) => entry.message);
}

async function attachMessages(record: SessionRecord): Promise<SessionWithMessages> {
  const entries = await readSessionMessageEntries(record.id);
  return {
    ...record,
    messages: entries.map((entry) => entry.message),
    messageEntryIds: entries.map((entry) => entry.entryId),
  };
}

export async function loadSession(sessionId: string): Promise<SessionWithMessages | undefined> {
  const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  return record ? attachMessages(record) : undefined;
}

export async function loadOwnedSession(
  userId: string,
  sessionId: string,
): Promise<SessionWithMessages | undefined> {
  const session = await loadSession(sessionId);
  return session?.userId === userId ? session : undefined;
}

export async function loadOwnedSessionPage(userId: string, sessionId: string, cursor?: string) {
  const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!record || record.userId !== userId) return undefined;
  return withPiSession(sessionId, async (pi) => {
    const page = await readPiSessionPage(pi, cursor);
    const entries = page.entries.flatMap((entry) =>
      entry.type === "message" ? [{ entryId: entry.id, message: entry.message }] : [],
    );
    return {
      ...record,
      messages: entries.map((entry) => entry.message),
      messageEntryIds: entries.map((entry) => entry.entryId),
      olderCursor: page.olderCursor,
    };
  });
}
