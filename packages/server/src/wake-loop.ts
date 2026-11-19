import type { StateTopic } from "@carmel-agent/shared";
import { subscribeStateChanges } from "./state-changes.ts";

export type WakeLoop = {
  wake: () => void;
  stop: () => void;
};

/**
 * Drive a background worker from committed state changes with a slow fallback
 * sweep and optional deadline scheduling (for retries or expiring timers).
 */
export function startWakeLoop(options: {
  topics: readonly StateTopic[];
  sweepMs: number;
  debounceMs?: number;
  runOnStart?: boolean;
  run: () => void | number | undefined | Promise<void | number | undefined>;
  onError?: (error: unknown) => void;
}): WakeLoop {
  const watched = new Set(options.topics);
  const debounceMs = options.debounceMs ?? 25;
  let stopped = false;
  let running = false;
  let pendingWake = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDeadline = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };

  const scheduleDeadline = (nextAt: number | void) => {
    clearDeadline();
    if (stopped || typeof nextAt !== "number" || !Number.isFinite(nextAt)) return;
    const delay = Math.max(50, Math.min(options.sweepMs, nextAt - Date.now()));
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      wake();
    }, delay);
    deadlineTimer.unref();
  };

  const execute = async () => {
    if (stopped || running) return;
    running = true;
    pendingWake = false;
    clearDeadline();
    try {
      const nextAt = await options.run();
      scheduleDeadline(nextAt);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      if (!stopped && pendingWake) {
        pendingWake = false;
        wake();
      }
    }
  };

  const wake = () => {
    if (stopped) return;
    if (running) {
      pendingWake = true;
      return;
    }
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void execute();
    }, debounceMs);
    debounceTimer.unref();
  };

  const unsubscribe = watched.size
    ? subscribeStateChanges((changes) => {
        for (const change of changes) {
          if (change.topics.some((topic) => watched.has(topic))) {
            wake();
            return;
          }
        }
      })
    : undefined;

  const sweepTimer = setInterval(wake, options.sweepMs);
  sweepTimer.unref();

  if (options.runOnStart ?? true) wake();

  return {
    wake,
    stop() {
      stopped = true;
      pendingWake = false;
      unsubscribe?.();
      clearInterval(sweepTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      clearDeadline();
    },
  };
}
