import { randomUUID } from "node:crypto";
import type { StateTopic } from "@carmel-agent/shared";

export const stateEpoch = randomUUID();
let revision = 0;
const listeners = new Set<(revision: number, topics: StateTopic[]) => void>();
const pending = new Set<StateTopic>();

export function stateRevision() {
  return revision;
}

export function publishStateChange(...topics: StateTopic[]) {
  if (!pending.size) queueMicrotask(flush);
  for (const topic of topics) pending.add(topic);
}

function flush() {
  if (!pending.size) return;
  const topics = [...pending];
  pending.clear();
  revision++;
  for (const listener of listeners) listener(revision, topics);
}

export function subscribeStateChanges(listener: (revision: number, topics: StateTopic[]) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
