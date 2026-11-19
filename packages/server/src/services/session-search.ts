import type { SessionSearchResult } from "@carmel-agent/shared";
import { and, desc, eq, gte, ne, or } from "drizzle-orm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor } from "@earendil-works/pi-durable";
import { db, sqlite } from "../db/index.ts";
import { agents, issueAttempts, issues, sessions } from "../db/schema.ts";
import { readVisibleAgent } from "./agent-access.ts";
import { displayEntries, withPiSession, resolveEntryId } from "./pi-session-storage.ts";
import {
  hasCjk,
  homeMemoryQueryTerms,
  memoryQueryEffectiveLength,
  sameMemoryWord,
} from "../home-memory/service.ts";

export const RECENT_WORK_WINDOW_MS = 48 * 3_600_000;
export const RECENT_WORK_MAX_LINES = 10;
export const RECENT_WORK_MAX_CHARS = 1_400;

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

async function indexSessions(owned: (typeof sessions.$inferSelect)[]) {
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
}

export function parseSessionTimeBound(
  value: string | undefined,
  endOfDay = false,
  nowMs = Date.now(),
): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  const span = /^(\d{1,4})\s*([mhdw])$/u.exec(text);
  if (span) {
    const amount = Number(span[1]);
    const unit =
      span[2] === "m"
        ? 60_000
        : span[2] === "h"
          ? 3_600_000
          : span[2] === "d"
            ? 86_400_000
            : 7 * 86_400_000;
    return nowMs - amount * unit;
  }
  if (text === "today" || text === "yesterday") {
    const day = new Date(nowMs);
    day.setHours(0, 0, 0, 0);
    if (text === "yesterday") day.setDate(day.getDate() - 1);
    if (endOfDay) day.setHours(23, 59, 59, 999);
    return day.getTime();
  }
  if (/^\d{12,}$/u.test(text)) return Number(text);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(text);
  const parsed = Date.parse(isDateOnly ? `${text}T00:00` : value.trim());
  if (!Number.isFinite(parsed)) return null;
  if (endOfDay && isDateOnly) {
    const end = new Date(parsed);
    end.setHours(23, 59, 59, 999);
    return end.getTime();
  }
  return parsed;
}

function ftsTermExpression(term: string) {
  if (!/^[\p{L}\p{N}_-]+$/u.test(term)) return `"${term.replaceAll('"', "")}"`;
  const stem =
    term.length > 4 && term.endsWith("s") && !term.endsWith("ss") ? term.slice(0, -1) : term;
  return stem.length >= 4 && /^\p{L}+$/u.test(stem) ? `"${stem}"*` : `"${term}"`;
}

function textMatchedTerms(text: string, terms: readonly string[]) {
  const lower = text.normalize("NFKC").toLowerCase();
  const words = lower.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  let matched = 0;
  for (const term of terms) {
    if (hasCjk(term) || !/^[\p{L}\p{N}_-]+$/u.test(term)) {
      if (lower.includes(term)) matched++;
    } else if (words.some((word) => sameMemoryWord(term, word)) || lower.includes(term)) {
      matched++;
    }
  }
  return matched;
}

function requiredSessionMatches(terms: readonly string[]) {
  const cjkCount = terms.filter(hasCjk).length;
  const wordCount = terms.length - cjkCount + Math.ceil(cjkCount / 2);
  return wordCount >= 5 ? 2 : 1;
}

export async function searchGlobalSessions(
  userId: string,
  query: string,
): Promise<SessionSearchResult[]> {
  const text = query.trim();
  if (!text) return [];
  const owned = db
    .select({ session: sessions })
    .from(sessions)
    .innerJoin(agents, eq(agents.id, sessions.agentId))
    .where(
      and(eq(sessions.userId, userId), or(eq(agents.ownerUserId, userId), eq(agents.shared, true))),
    )
    .all()
    .map((row) => row.session);
  await indexSessions(owned);
  const matches = sqlite
    .prepare(`WITH message_matches AS (
        SELECT s.id AS sessionId, s.agent_id AS agentId, s.title,
          f.entry_id AS entryId,
          substr(f.text, max(1, instr(lower(f.text), lower(?)) - 80), max(280, length(?) + 80)) AS excerpt,
          s.updated_at AS updatedAt,
          row_number() OVER (
            PARTITION BY f.text ORDER BY s.updated_at DESC, s.id, f.entry_id
          ) AS duplicateIndex
        FROM session_search f JOIN sessions s ON s.id = f.session_id
          JOIN agents a ON a.id = s.agent_id
        WHERE s.user_id = ? AND (a.owner_user_id = ? OR a.shared = 1)
          AND instr(lower(f.text), lower(?)) > 0
      )
      SELECT s.id AS sessionId, s.agent_id AS agentId, s.title,
        NULL AS entryId, '' AS excerpt, s.updated_at AS updatedAt, 0 AS kind
      FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.user_id = ? AND (a.owner_user_id = ? OR a.shared = 1)
        AND instr(lower(s.title), lower(?)) > 0
      UNION ALL
      SELECT sessionId, agentId, title, entryId, excerpt, updatedAt, 1 AS kind
      FROM message_matches WHERE duplicateIndex = 1
      ORDER BY kind, updatedAt DESC, sessionId, entryId LIMIT 50`)
    .all(text, text, userId, userId, text, userId, userId, text) as Array<{
    sessionId: string;
    agentId: string;
    title: string;
    entryId: string | null;
    excerpt: string;
  }>;
  return matches.map(({ sessionId, agentId, title, entryId, excerpt }) => ({
    sessionId,
    agentId,
    title,
    ...(entryId ? { entryId } : {}),
    excerpt,
    link: `/agents/${agentId}/sessions/${sessionId}${entryId ? `?entry=${encodeURIComponent(entryId)}` : ""}`,
  }));
}

export type SessionSearchOptions = {
  since?: string;
  until?: string;
  excludeSessionId?: string;
  beforeSeqBySession?: ReadonlyMap<string, number>;
  limit?: number;
};

function parseDurableSeq(entryId: string): number | null {
  return /^durable:\d+$/u.test(entryId) ? Number(entryId.slice(8)) : null;
}

export async function searchSessions(
  userId: string,
  agentId: string,
  query: string,
  includeArchived = false,
  options?: SessionSearchOptions,
) {
  if (!readVisibleAgent(userId, agentId)) throw new Error("Agent not found.");
  const sinceMs = parseSessionTimeBound(options?.since, false);
  const untilMs = parseSessionTimeBound(options?.until, true);
  const bound = Math.min(20, Math.max(1, options?.limit ?? 20));
  const owned = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.agentId, agentId)))
    .orderBy(desc(sessions.updatedAt), sessions.id)
    .all()
    .filter(
      (session) =>
        (includeArchived || !session.archivedAt) &&
        (!options?.excludeSessionId || session.id !== options.excludeSessionId) &&
        (sinceMs === null || session.updatedAt >= sinceMs),
    );
  if (!owned.length) return [];
  await indexSessions(owned);

  const trimmed = query.trim();
  if (!trimmed) {
    if (sinceMs === null && untilMs === null) return [];
    const recentRows = sqlite
      .prepare(
        `SELECT f.session_id AS sessionId, f.entry_id AS entryId, s.title, f.text AS excerpt, s.updated_at AS updatedAt
         FROM session_search f JOIN sessions s ON s.id = f.session_id
         WHERE s.user_id = ? AND s.agent_id = ? AND (? OR s.archived_at IS NULL)
         ORDER BY s.updated_at DESC, f.rowid DESC LIMIT ?`,
      )
      .all(userId, agentId, includeArchived ? 1 : 0, bound * 3) as Array<{
      sessionId: string;
      entryId: string;
      title: string;
      excerpt: string;
      updatedAt: number;
    }>;
    const results = [];
    for (const match of recentRows) {
      if (options?.excludeSessionId && match.sessionId === options.excludeSessionId) continue;
      const maxSeq = options?.beforeSeqBySession?.get(match.sessionId);
      const seq = parseDurableSeq(match.entryId);
      if (maxSeq !== undefined && seq !== null && seq >= maxSeq) continue;
      if (sinceMs !== null && match.updatedAt < sinceMs) continue;
      if (untilMs !== null && match.updatedAt > untilMs && sinceMs === null) continue;
      const source = await readSessionExcerpt(userId, agentId, match.sessionId, match.entryId, 1);
      if (!source.messages.length) continue;
      results.push({
        sessionId: match.sessionId,
        entryId: match.entryId,
        title: match.title,
        excerpt: source.messages[0]!.text.slice(0, 1600),
        link: `/agents/${agentId}/sessions/${match.sessionId}?entry=${encodeURIComponent(match.entryId)}`,
      });
      if (results.length >= bound) break;
    }
    return results;
  }

  let terms = homeMemoryQueryTerms(trimmed);
  if (!terms.length) {
    terms = (trimmed.toLowerCase().match(/[^\s]+/gu) ?? []).slice(0, 8);
  }
  if (!terms.length) return [];
  const minMatches = requiredSessionMatches(terms);
  const ftsTerms = terms.filter((term) => !hasCjk(term) && /^[\p{L}\p{N}_-]+$/u.test(term));
  const substringTerms = terms.filter((term) => hasCjk(term) || !/^[\p{L}\p{N}_-]+$/u.test(term));

  const candidateMap = new Map<
    string,
    {
      sessionId: string;
      entryId: string;
      title: string;
      text: string;
      updatedAt: number;
      ftsOrder: number;
    }
  >();

  if (ftsTerms.length) {
    try {
      const ftsMatches = sqlite
        .prepare(`SELECT f.session_id AS sessionId, f.entry_id AS entryId, s.title, f.text, s.updated_at AS updatedAt
        FROM session_search f JOIN sessions s ON s.id = f.session_id
        WHERE session_search MATCH ? AND s.user_id = ? AND s.agent_id = ? AND (? OR s.archived_at IS NULL)
        ORDER BY rank LIMIT ?`)
        .all(
          ftsTerms.map(ftsTermExpression).join(" OR "),
          userId,
          agentId,
          includeArchived ? 1 : 0,
          bound * 3,
        ) as Array<{
        sessionId: string;
        entryId: string;
        title: string;
        text: string;
        updatedAt: number;
      }>;
      ftsMatches.forEach((row, index) => {
        candidateMap.set(`${row.sessionId}:${row.entryId}`, { ...row, ftsOrder: index });
      });
    } catch {
      // Fallback to substring scan below.
    }
  }

  if (substringTerms.length || candidateMap.size === 0) {
    const probe = substringTerms[0] ?? trimmed.toLowerCase();
    const subMatches = sqlite
      .prepare(`SELECT f.session_id AS sessionId, f.entry_id AS entryId, s.title, f.text, s.updated_at AS updatedAt
      FROM session_search f JOIN sessions s ON s.id = f.session_id
      WHERE s.user_id = ? AND s.agent_id = ? AND (? OR s.archived_at IS NULL)
        AND instr(lower(f.text), lower(?)) > 0
      ORDER BY s.updated_at DESC, f.rowid DESC LIMIT ?`)
      .all(userId, agentId, includeArchived ? 1 : 0, probe, bound * 3) as Array<{
      sessionId: string;
      entryId: string;
      title: string;
      text: string;
      updatedAt: number;
    }>;
    subMatches.forEach((row, index) => {
      const key = `${row.sessionId}:${row.entryId}`;
      if (!candidateMap.has(key)) candidateMap.set(key, { ...row, ftsOrder: 1000 + index });
    });
  }

  const ranked = [...candidateMap.values()]
    .filter((row) => {
      if (options?.excludeSessionId && row.sessionId === options.excludeSessionId) return false;
      const maxSeq = options?.beforeSeqBySession?.get(row.sessionId);
      const seq = parseDurableSeq(row.entryId);
      if (maxSeq !== undefined && seq !== null && seq >= maxSeq) return false;
      if (sinceMs !== null && row.updatedAt < sinceMs) return false;
      if (untilMs !== null && row.updatedAt > untilMs && sinceMs === null) return false;
      return textMatchedTerms(row.text, terms) >= minMatches;
    })
    .sort(
      (a, b) =>
        textMatchedTerms(b.text, terms) - textMatchedTerms(a.text, terms) ||
        a.ftsOrder - b.ftsOrder ||
        b.updatedAt - a.updatedAt,
    )
    .slice(0, bound);

  const results = [];
  for (const match of ranked) {
    const source = await readSessionExcerpt(userId, agentId, match.sessionId, match.entryId, 1);
    if (!source.messages.length) continue;
    const excerptText = source.messages[0]!.text.slice(0, 1600);
    if (textMatchedTerms(excerptText, terms) < minMatches) continue;
    results.push({
      sessionId: match.sessionId,
      entryId: match.entryId,
      title: match.title,
      excerpt: excerptText,
      link: `/agents/${agentId}/sessions/${match.sessionId}?entry=${encodeURIComponent(match.entryId)}`,
    });
  }
  return results;
}

export async function recallHomeConversations(
  userId: string,
  agentId: string,
  homeSessionId: string,
  query: string,
  limit = 4,
) {
  const recallQuery = query.trim().slice(0, 500);
  if (memoryQueryEffectiveLength(recallQuery) < 8) return [];
  return searchSessions(userId, agentId, recallQuery, false, {
    excludeSessionId: homeSessionId,
    limit,
  });
}

function formatWhenLabel(at: number, nowMs: number) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const then = new Date(at);
  const today = new Date(nowMs);
  const time = `${pad(then.getHours())}:${pad(then.getMinutes())}`;
  const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (dayOf(then) === dayOf(today)) return `today ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayOf(then) === dayOf(yesterday)) return `yesterday ${time}`;
  return `${dayOf(then)} ${time}`;
}

function foldBriefText(text: string, maxChars: number) {
  const folded = text
    .replace(/<\/?[a-z_][\w-]*[^>]*>/giu, "")
    .replace(/```/gu, "'''")
    .replace(/\s+/gu, " ")
    .trim();
  return folded.length > maxChars ? `${folded.slice(0, maxChars - 1)}…` : folded;
}

export function buildHomeRecentWorkBrief(
  userId: string,
  agentId: string,
  homeSessionId: string,
  nowMs = Date.now(),
): string | undefined {
  if (!readVisibleAgent(userId, agentId)) return undefined;
  const since = nowMs - RECENT_WORK_WINDOW_MS;
  const items: Array<{ at: number; line: string }> = [];

  const recentIssues = db
    .select()
    .from(issues)
    .where(
      and(eq(issues.userId, userId), eq(issues.agentId, agentId), gte(issues.updatedAt, since)),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(RECENT_WORK_MAX_LINES)
    .all();

  for (const issue of recentIssues) {
    const latestAttempt = db
      .select()
      .from(issueAttempts)
      .where(eq(issueAttempts.issueId, issue.id))
      .orderBy(desc(issueAttempts.createdAt))
      .get();
    const detail =
      latestAttempt?.summary || issue.verdictSummary || issue.lastRunDetail || issue.description;
    const summary = detail ? ` · "${foldBriefText(detail, 160)}"` : "";
    items.push({
      at: issue.updatedAt,
      line: `- ${formatWhenLabel(issue.updatedAt, nowMs)} · task "${foldBriefText(issue.title, 60)}" (${issue.status} · /agents/${agentId}/tasks/${issue.id})${summary}`,
    });
  }

  const recentSessions = db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        eq(sessions.agentId, agentId),
        ne(sessions.id, homeSessionId),
        gte(sessions.updatedAt, since),
      ),
    )
    .orderBy(desc(sessions.updatedAt))
    .limit(RECENT_WORK_MAX_LINES)
    .all()
    .filter((session) => !session.archivedAt && !session.issueId);

  for (const session of recentSessions) {
    const latestRow = sqlite
      .prepare("SELECT text FROM session_search WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(session.id) as { text: string } | undefined;
    const summary = latestRow?.text ? ` · "${foldBriefText(latestRow.text, 160)}"` : "";
    items.push({
      at: session.updatedAt,
      line: `- ${formatWhenLabel(session.updatedAt, nowMs)} · session "${foldBriefText(session.title || "Chat", 60)}" (/agents/${agentId}/sessions/${session.id})${summary}`,
    });
  }

  if (!items.length) return undefined;
  items.sort((a, b) => b.at - a.at);
  const lines: string[] = [];
  let chars = 0;
  for (const item of items.slice(0, RECENT_WORK_MAX_LINES)) {
    if (chars + item.line.length + 1 > RECENT_WORK_MAX_CHARS) break;
    lines.push(item.line);
    chars += item.line.length + 1;
  }
  return lines.length ? lines.join("\n") : undefined;
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
