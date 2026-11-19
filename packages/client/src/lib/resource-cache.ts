import type { StateTopic } from "@carmel-agent/shared";
import { createResourceLoader } from "./resource-loader.ts";
import { updateConnection } from "./update-connection.ts";

export type ResourceSnapshot<T> = {
  data?: T;
  error?: string;
};

type CacheEntry<T = unknown> = {
  key: string;
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  loader?: ReturnType<typeof createResourceLoader<T>>;
  load?: (signal: AbortSignal) => Promise<T>;
  formatError?: (error: unknown) => string;
  unsubscribeTopics?: () => void;
  topicKey: string;
  topics: readonly StateTopic[];
  lastTouched: number;
};

const MAX_UNMOUNTED_ENTRIES = 120;
const EMPTY_SNAPSHOT: ResourceSnapshot<never> = {};

const entries = new Map<string, CacheEntry>();

updateConnection.observeInvalidations((topics) => {
  for (const [key, entry] of entries) {
    if (entry.listeners.size > 0) continue;
    if (entry.topics.some((topic) => topics.includes(topic))) entries.delete(key);
  }
});

function getOrCreateEntry<T>(key: string): CacheEntry<T> {
  let entry = entries.get(key) as CacheEntry<T> | undefined;
  if (!entry) {
    entry = {
      key,
      snapshot: EMPTY_SNAPSHOT as ResourceSnapshot<T>,
      listeners: new Set(),
      topicKey: "",
      topics: [],
      lastTouched: Date.now(),
    };
    entries.set(key, entry as CacheEntry);
  }
  entry.lastTouched = Date.now();
  return entry;
}

function notify(entry: CacheEntry) {
  for (const listener of entry.listeners) listener();
}

function pruneUnmounted() {
  if (entries.size <= MAX_UNMOUNTED_ENTRIES) return;
  const idle = [...entries.values()]
    .filter((entry) => entry.listeners.size === 0)
    .sort((a, b) => a.lastTouched - b.lastTouched);
  let excess = entries.size - MAX_UNMOUNTED_ENTRIES;
  for (const entry of idle) {
    if (excess <= 0) break;
    entries.delete(entry.key);
    excess--;
  }
}

function syncTopicSubscription(entry: CacheEntry, topicKey: string) {
  const topics = topicKey ? (topicKey.split(",") as StateTopic[]) : [];
  entry.topics = topics;
  if (entry.topicKey === topicKey && entry.unsubscribeTopics) return;
  entry.unsubscribeTopics?.();
  entry.unsubscribeTopics = undefined;
  entry.topicKey = topicKey;
  if (topics.length > 0 && entry.listeners.size > 0) {
    entry.unsubscribeTopics = updateConnection.subscribe(topics, () => {
      entry.loader?.invalidate();
    });
  }
}

export function getResourceSnapshot<T>(key: string): ResourceSnapshot<T> {
  return (entries.get(key)?.snapshot as ResourceSnapshot<T> | undefined) ?? EMPTY_SNAPSHOT;
}

export function setResourceData<T>(key: string, updater: (current: T | undefined) => T) {
  const entry = getOrCreateEntry<T>(key);
  entry.snapshot = { data: updater(entry.snapshot.data) };
  notify(entry as CacheEntry);
}

export function invalidateResource(key: string) {
  entries.get(key)?.loader?.invalidate();
}

export function clearResourceCache() {
  for (const entry of entries.values()) {
    entry.unsubscribeTopics?.();
    entry.loader?.dispose();
  }
  entries.clear();
}

export function retainResource<T>(options: {
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
  formatError: (error: unknown) => string;
  topicKey: string;
  onChange: () => void;
}) {
  const entry = getOrCreateEntry<T>(options.key);
  entry.load = options.load;
  entry.formatError = options.formatError;
  entry.listeners.add(options.onChange);

  if (!entry.loader) {
    entry.loader = createResourceLoader<T>(
      (signal) => entry.load!(signal),
      (result) => {
        if ("error" in result) {
          entry.snapshot = {
            data: entry.snapshot.data,
            error: entry.formatError ? entry.formatError(result.error) : String(result.error),
          };
        } else {
          entry.snapshot = { data: result.data };
        }
        entry.lastTouched = Date.now();
        notify(entry as CacheEntry);
      },
    );
  }

  syncTopicSubscription(entry as CacheEntry, options.topicKey);
  void entry.loader.refresh();

  const reconnect = () => {
    if (!document.hidden) void entry.loader?.refresh(true);
  };
  window.addEventListener("online", reconnect);
  document.addEventListener("visibilitychange", reconnect);

  return {
    refresh: () => entry.loader?.refresh(true) ?? Promise.resolve(undefined),
    release() {
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
      entry.listeners.delete(options.onChange);
      if (entry.listeners.size === 0) {
        entry.unsubscribeTopics?.();
        entry.unsubscribeTopics = undefined;
        entry.topicKey = "";
        entry.loader?.dispose();
        entry.loader = undefined;
        entry.lastTouched = Date.now();
        pruneUnmounted();
      }
    },
  };
}
