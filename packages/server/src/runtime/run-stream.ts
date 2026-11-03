import type { AgentRunEvent, AgentRunEventEnvelope, AgentRunResult } from "@carmel-agent/shared";
import { applyRunProgress, type RunProgress } from "@carmel-agent/shared";
import { INTERRUPTED_DETAIL, type RunAbortReason } from "../effectors/run-outcome.ts";
import { publishStateChange } from "../state-changes.ts";

const maxReplayEvents = 1_000;

export type RunEvent = AgentRunEvent;

export type ActiveAgentRun = {
  runId: string;
  userId: string;
  sessionId: string;
  /** Says who is stopping the run, which decides how its result reads. Defaults to a person. */
  abort: (reason?: RunAbortReason) => void;
  events: AgentRunEventEnvelope[];
  subscribers: Set<RunSubscriber>;
  nextSequence: number;
  finished: boolean;
  /** How the run ended. Set when it finishes. */
  result?: AgentRunResult;
  started: boolean;
  progress: RunProgress;
  /** Called with the result as the run is released; see `onRunFinished`. */
  finishListeners?: Array<(result: AgentRunResult) => void>;
};

export type RunSubscriber = {
  enqueue: (envelope: AgentRunEventEnvelope) => boolean;
  close: () => void;
};

const activeAgentRuns = new Map<string, ActiveAgentRun>();
const activeSessionRuns = new Map<string, string>();
const sessionRunVersions = new Map<string, number>();

function advanceSessionRun(sessionId: string) {
  sessionRunVersions.set(sessionId, (sessionRunVersions.get(sessionId) ?? 0) + 1);
}

export function createActiveAgentRun(input: {
  runId: string;
  userId: string;
  sessionId: string;
  abort: (reason?: RunAbortReason) => void;
}) {
  const run: ActiveAgentRun = {
    ...input,
    events: [],
    subscribers: new Set(),
    nextSequence: 1,
    finished: false,
    started: false,
    progress: {},
  };
  activeAgentRuns.set(run.runId, run);
  activeSessionRuns.set(run.sessionId, run.runId);
  advanceSessionRun(run.sessionId);
  publishStateChange("sessions", "homes", "tasks", "issues");
  return run;
}

export function abortAgentRun(userId: string, runId: string) {
  const run = activeAgentRuns.get(runId);
  if (!run || run.userId !== userId) return false;
  run.abort();
  return true;
}

export function getActiveAgentRunForSession(userId: string, sessionId: string) {
  const summary = getActiveAgentRunForSessionId(sessionId);
  if (!summary) return undefined;
  const run = activeAgentRuns.get(summary.runId);
  return run?.userId === userId ? summary : undefined;
}

export function getActiveAgentRunForSessionId(sessionId: string) {
  const runId = activeSessionRuns.get(sessionId);
  if (!runId) return undefined;
  const run = activeAgentRuns.get(runId);
  if (!run || run.sessionId !== sessionId) return undefined;
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    eventCursor: run.nextSequence - 1,
  };
}

export function getActiveSessionIdsForUser(userId: string) {
  return [...activeAgentRuns.values()]
    .filter((run) => run.userId === userId)
    .map((run) => run.sessionId);
}

export function agentRunSubscription(userId: string, runId: string, afterSequence: number) {
  const run = activeAgentRuns.get(runId);
  if (!run || run.userId !== userId) return { status: 404 as const };
  if (afterSequence > run.nextSequence - 1) return { status: 400 as const };
  const first = run.events[0]?.sequence ?? run.nextSequence;
  if (afterSequence < first - 1) return { status: 409 as const };
  return {
    status: 200 as const,
    subscribe(subscriber: RunSubscriber) {
      return subscribeRunEvents(run, afterSequence, subscriber);
    },
  };
}

export function sessionRunVersion(sessionId: string) {
  return sessionRunVersions.get(sessionId) ?? 0;
}

export function sessionRunSnapshot(userId: string, sessionId: string) {
  const runId = activeSessionRuns.get(sessionId);
  const run = runId ? activeAgentRuns.get(runId) : undefined;
  if (!run || run.userId !== userId) return { activeRun: null };
  return {
    activeRun: { runId: run.runId, sessionId, eventCursor: run.nextSequence - 1 },
    runProgress: run.progress,
  };
}

// Abort every in-flight run and wait for their finally blocks to persist
// messages, so a restart does not lose an active turn. Resolves once all runs
// have drained or the timeout elapses. This lifecycle abort is server-owned;
// disconnecting an event-stream subscriber never calls it.
export async function shutdownActiveRuns(timeoutMs = 10_000) {
  const runs = [...activeAgentRuns.values()];
  if (runs.length === 0) return;
  for (const run of runs) {
    try {
      run.abort("shutdown");
    } catch {
      // Best effort: a failing abort should not block the others.
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (activeAgentRuns.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function finishAgentRun(run: ActiveAgentRun, result?: AgentRunResult) {
  run.result = result;
  run.finished = true;
  activeAgentRuns.delete(run.runId);
  activeSessionRuns.delete(run.sessionId);
  advanceSessionRun(run.sessionId);
  publishStateChange("sessions", "homes", "tasks", "issues");
  for (const subscriber of run.subscribers) subscriber.close();
  run.subscribers.clear();
  const listeners = run.finishListeners ?? [];
  run.finishListeners = undefined;
  for (const listener of listeners) {
    try {
      listener(runResultOf(run));
    } catch (error) {
      console.warn("A run finish listener failed:", error);
    }
  }
}

/**
 * Call `listener` with the run's result in the same tick the run is released.
 *
 * For state that must never be read half-updated: anything derived from the
 * active-run registry (is it running?) and anything this records (how did it
 * end?) change together, where `whenRunFinished` would leave a poll-interval
 * gap between the two.
 */
export function onRunFinished(run: ActiveAgentRun, listener: (result: AgentRunResult) => void) {
  if (run.finished) {
    listener(runResultOf(run));
    return;
  }
  (run.finishListeners ??= []).push(listener);
}

function runResultOf(run: ActiveAgentRun): AgentRunResult {
  // Only a run released without finalization -- a test's held lease -- has none.
  return run.result ?? { outcome: "interrupted", detail: INTERRUPTED_DETAIL };
}

/**
 * Resolve with a run's result once it has finished.
 *
 * For callers with no stream to close, which is what "finished" otherwise means
 * here. Polled rather than event-driven because `finishAgentRun` is reached
 * from a `finally` on several paths, and adding a notification to each of them
 * would be more surface than a scheduler tick needs.
 */
export async function whenRunFinished(run: ActiveAgentRun, pollMs = 200): Promise<AgentRunResult> {
  while (!run.finished) await new Promise((resolve) => setTimeout(resolve, pollMs));
  return runResultOf(run);
}

export function observeRunEvents(run: ActiveAgentRun, afterSequence = 0) {
  let unsubscribe: (() => void) | undefined;
  return new ReadableStream<AgentRunEventEnvelope>({
    start(controller) {
      unsubscribe = subscribeRunEvents(run, afterSequence, {
        enqueue: (envelope) => {
          controller.enqueue(envelope);
          return true;
        },
        close: () => controller.close(),
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });
}

function subscribeRunEvents(run: ActiveAgentRun, afterSequence: number, subscriber: RunSubscriber) {
  for (const event of run.events) {
    if (event.sequence > afterSequence && !subscriber.enqueue(event)) return () => {};
  }
  if (run.finished) subscriber.close();
  else run.subscribers.add(subscriber);
  return () => run.subscribers.delete(subscriber);
}

/** Native Durable already batches progress; The transport sequences and replays it. */
export function emitRunEvent(run: ActiveAgentRun, event: RunEvent) {
  advanceSessionRun(run.sessionId);
  run.progress = applyRunProgress(run.progress, event);
  if (event.type === "live_update") publishStateChange("subtasks");
  const envelope: AgentRunEventEnvelope = { sequence: run.nextSequence++, event };

  run.events.push(envelope);
  if (run.events.length > maxReplayEvents)
    run.events.splice(0, run.events.length - maxReplayEvents);

  for (const subscriber of run.subscribers) {
    if (!subscriber.enqueue(envelope)) run.subscribers.delete(subscriber);
  }
  return run.subscribers.size > 0;
}
