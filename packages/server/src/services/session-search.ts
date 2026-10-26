import { and, eq } from "drizzle-orm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor } from "@earendil-works/pi-durable";
import { db, sqlite } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { readVisibleAgent } from "./agent-access.ts";
import { displayEntries, withPiSession, resolveEntryId } from "./pi-session-storage.ts";

function requireSession(userId: string, agentId: string, sessionId: string) {
  if (!readVisibleAgent(userId, agentId)) throw new Error("Agent not found.");
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session || session.userId !== userId || session.agentId !== agentId)
    throw new Error("Conversation not found.");
  return session;
}

function textOf(entry: ReturnType<typeof displayEntries>[number]) {
  if (
    entry.type !== "message" ||
    (entry.message.role !== "user" && entry.message.role !== "assistant")
  )
    return "";
  const content = entry.message.content;
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export async function searchSessions(
  userId: string,
  agentId: string,
  query: string,
  includeArchived = false,
) {
  if (!readVisibleAgent(userId, agentId)) throw new Error("Agent not found.");
  const terms = query
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.slice(0, 8)
    .map((term) => `"${term}"`)
    .join(" AND ");
  if (!terms) return [];
  const owned = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.agentId, agentId)))
    .all()
    .filter((session) => includeArchived || !session.archivedAt);
  for (const session of owned) {
    const indexed = sqlite
      .prepare("SELECT revision FROM session_search_state WHERE session_id = ?")
      .get(session.id) as { revision: number } | undefined;
    if (indexed?.revision === session.revision) continue;
    sqlite.prepare("DELETE FROM session_search WHERE session_id = ?").run(session.id);
    await withPiSession(session.id, async (pi) => {
      let cursor: Cursor | undefined;
      do {
        const page = await pi.conversation.entries(
          { order: "ascending" },
          250,
          cursor,
          BACKGROUND_CONTEXT,
        );
        sqlite.transaction(() => {
          const insert = sqlite.prepare(
            "INSERT INTO session_search(session_id, entry_id, text) VALUES (?, ?, ?)",
          );
          for (const entry of displayEntries(page.items, session.id)) {
            const text = textOf(entry);
            if (text) insert.run(session.id, entry.id, text);
          }
        })();
        cursor = page.next;
      } while (cursor);
    });
    sqlite
      .prepare("INSERT OR REPLACE INTO session_search_state(session_id, revision) VALUES (?, ?)")
      .run(session.id, session.revision);
  }
  const matches = sqlite
    .prepare(`SELECT f.session_id AS sessionId, f.entry_id AS entryId, s.title, snippet(session_search, 2, '', '', '…', 40) AS excerpt
    FROM session_search f JOIN sessions s ON s.id = f.session_id
    WHERE session_search MATCH ? AND s.user_id = ? AND s.agent_id = ? AND (? OR s.archived_at IS NULL)
    ORDER BY rank LIMIT 20`)
    .all(terms, userId, agentId, includeArchived ? 1 : 0) as Array<{
    sessionId: string;
    entryId: string;
    title: string;
    excerpt: string;
  }>;
  const results = [];
  for (const match of matches) {
    const source = await readSessionExcerpt(userId, agentId, match.sessionId, match.entryId, 1);
    if (!source.messages.length) continue;
    results.push({
      ...match,
      excerpt: source.messages[0]!.text.slice(0, 1600),
      link: `/agents/${agentId}/sessions/${match.sessionId}?entry=${encodeURIComponent(match.entryId)}`,
    });
  }
  return results;
}

export async function readSessionExcerpt(
  userId: string,
  agentId: string,
  sessionId: string,
  beforeEntryId?: string,
  limit = 30,
) {
  const session = requireSession(userId, agentId, sessionId);
  return withPiSession(sessionId, async (pi) => {
    const maxEntryId = beforeEntryId ? await resolveEntryId(pi, beforeEntryId) : undefined;
    const page = await pi.conversation.entries(
      { order: "descending", maxEntryId },
      Math.min(limit, 100),
      undefined,
      BACKGROUND_CONTEXT,
    );
    if (maxEntryId && page.items[0]?.id !== maxEntryId)
      return { sessionId, title: session.title, messages: [], truncated: false };
    let remaining = 12000;
    const messages = displayEntries(page.items, sessionId)
      .flatMap((entry) => {
        const text = textOf(entry).slice(0, Math.min(2000, remaining));
        remaining -= text.length;
        return text ? [{ entryId: entry.id, text }] : [];
      })
      .reverse();
    return {
      sessionId,
      title: session.title,
      messages,
      truncated: Boolean(page.next) || remaining <= 0,
    };
  });
}
