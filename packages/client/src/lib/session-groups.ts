import type { SessionMetadata } from "@carmel-agent/shared";

export type SessionGroup<T> = { label: string; sessions: T[] };

type Groupable = Pick<SessionMetadata, "title" | "pinnedAt" | "updatedAt">;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pinned first, newest pin first; the rest by last activity. */
export function sortSessions<T extends Pick<SessionMetadata, "pinnedAt" | "updatedAt">>(a: T, b: T) {
  if (a.pinnedAt && b.pinnedAt) return b.pinnedAt - a.pinnedAt;
  if (a.pinnedAt) return -1;
  if (b.pinnedAt) return 1;
  return b.updatedAt - a.updatedAt;
}

/** Every whitespace-separated term must appear in the title, in any case. */
export function matchesSessionQuery(session: Pick<SessionMetadata, "title">, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const title = session.title.toLowerCase();
  return terms.every((term) => title.includes(term));
}

/**
 * Pinned sessions, then recency buckets by local calendar day, then one group
 * per month. Groups keep the list's own order and empty ones are left out.
 */
export function groupSessions<T extends Groupable>(sessions: readonly T[], now = Date.now()): SessionGroup<T>[] {
  const todayStart = startOfDay(now);
  const buckets: Array<{ label: string; from: number }> = [
    { label: "Today", from: todayStart },
    { label: "Yesterday", from: todayStart - DAY_MS },
    { label: "Previous 7 days", from: todayStart - 7 * DAY_MS },
    { label: "Previous 30 days", from: todayStart - 30 * DAY_MS },
  ];
  const groups = new Map<string, T[]>();
  const add = (label: string, session: T) => {
    const group = groups.get(label);
    if (group) group.push(session);
    else groups.set(label, [session]);
  };

  for (const session of [...sessions].sort(sortSessions)) {
    if (session.pinnedAt) {
      add("Pinned", session);
      continue;
    }
    const bucket = buckets.find((candidate) => session.updatedAt >= candidate.from);
    add(bucket?.label ?? monthLabel(session.updatedAt, now), session);
  }
  return [...groups].map(([label, grouped]) => ({ label, sessions: grouped }));
}

/**
 * The first `limit` sessions across groups, in order, and how many were left
 * out. Rendering hundreds of rows at once is what makes a long list slow; this
 * is what the list shows before "Show more".
 */
export function limitGroups<T>(groups: readonly SessionGroup<T>[], limit: number) {
  const shown: SessionGroup<T>[] = [];
  let remaining = limit;
  let hidden = 0;
  for (const group of groups) {
    if (remaining <= 0) {
      hidden += group.sessions.length;
      continue;
    }
    const sessions = group.sessions.slice(0, remaining);
    shown.push({ label: group.label, sessions });
    hidden += group.sessions.length - sessions.length;
    remaining -= sessions.length;
  }
  return { groups: shown, hidden };
}

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function monthLabel(time: number, now: number) {
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", sameYear ? { month: "long" } : { month: "long", year: "numeric" });
}
