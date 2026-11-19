import { randomUUID } from "node:crypto";
import type { StateTopic } from "@carmel-agent/shared";

/** A batch of changed topics. Without a `userId` it concerns everyone. */
export type StateChange = { userId?: string; topics: StateTopic[] };

export const stateEpoch = randomUUID();
const everyone = "";
const listeners = new Set<(changes: StateChange[]) => void>();
const pending = new Map<string, Set<StateTopic>>();

export function publishStateChange(...topics: StateTopic[]) {
  publishUserStateChange(undefined, ...topics);
}

/** Changes to rows only `userId` (and, for tasks, admins) can see. */
export function publishUserStateChange(userId: string | null | undefined, ...topics: StateTopic[]) {
  if (!pending.size) queueMicrotask(flush);
  const key = userId ?? everyone;
  let set = pending.get(key);
  if (!set) pending.set(key, (set = new Set()));
  for (const topic of topics) set.add(topic);
}

function flush() {
  if (!pending.size) return;
  const changes = [...pending].map(([key, topics]) => ({
    ...(key === everyone ? {} : { userId: key }),
    topics: [...topics],
  }));
  pending.clear();
  for (const listener of listeners) listener(changes);
}

export function subscribeStateChanges(listener: (changes: StateChange[]) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let currentAuthRevision = 0;
let authChangeQueued = false;
const authChangeListeners = new Set<() => void>();

export function authRevision() {
  return currentAuthRevision;
}

export function notifyAuthChanged() {
  currentAuthRevision++;
  if (authChangeQueued) return;
  authChangeQueued = true;
  queueMicrotask(() => {
    authChangeQueued = false;
    for (const listener of authChangeListeners) listener();
  });
}

export function subscribeAuthChanges(listener: () => void) {
  authChangeListeners.add(listener);
  return () => authChangeListeners.delete(listener);
}

/** Admins can list every user's scheduled tasks, so those changes reach them too. */
const adminTopics: ReadonlySet<StateTopic> = new Set(["tasks"]);

export function topicsFor(changes: StateChange[], user: { id: string; role: string }) {
  const topics = new Set<StateTopic>();
  for (const change of changes)
    for (const topic of change.topics)
      if (
        !change.userId ||
        change.userId === user.id ||
        (user.role === "admin" && adminTopics.has(topic))
      )
        topics.add(topic);
  return [...topics];
}
