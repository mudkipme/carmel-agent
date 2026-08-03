import type { AgentRunEvent, AgentRunEventEnvelope } from "@carmel-agent/shared";

const maxReplayEvents = 1_000;

/**
 * Text and thinking deltas are buffered for this long and emitted as one event.
 * A model streams tokens far faster than a person reads them, and on a slow link
 * the per-frame overhead costs more than the bytes; ~20 updates/second still
 * reads as continuous typing.
 */
const deltaCoalesceMs = 50;

export type RunEvent = AgentRunEvent;

type PendingDelta = Extract<AgentRunEvent, { type: "message_delta" }>;

export type ActiveAgentRun = {
  runId: string;
  userId: string;
  sessionId: string;
  abort: () => void;
  events: AgentRunEventEnvelope[];
  subscribers: Set<RunSubscriber>;
  nextSequence: number;
  finished: boolean;
  started: boolean;
  /** Deltas accumulated since the last flush, not yet sequenced. */
  pendingDelta?: PendingDelta;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** Sequence of the `message_start` whose message is still streaming. */
  streamingSince?: number;
};

type RunSubscriber = {
  enqueue: (envelope: AgentRunEventEnvelope) => boolean;
  close: () => void;
};

const activeAgentRuns = new Map<string, ActiveAgentRun>();
const activeSessionRuns = new Map<string, string>();

export function createActiveAgentRun(input: {
  runId: string;
  userId: string;
  sessionId: string;
  abort: () => void;
}) {
  const run: ActiveAgentRun = {
    ...input,
    events: [],
    subscribers: new Set(),
    nextSequence: 1,
    finished: false,
    started: false,
  };
  activeAgentRuns.set(run.runId, run);
  activeSessionRuns.set(run.sessionId, run.runId);
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
    eventCursor: attachCursor(run),
  };
}

/**
 * Where a client joining this run should start reading.
 *
 * A subscriber rebuilds the streaming message from deltas, so joining mid-message
 * has to rewind to the `message_start` that seeded it -- otherwise the first
 * deltas apply to nothing and the message shows up missing its beginning until
 * `message_end` lands. Never rewinds past what the replay buffer still holds:
 * that cursor would be rejected as a replay gap, and the 409 path resolves the
 * gap by asking for this same cursor again.
 */
function attachCursor(run: ActiveAgentRun) {
  const latest = run.nextSequence - 1;
  if (run.streamingSince === undefined) return latest;
  const firstAvailable = run.events[0]?.sequence ?? run.nextSequence;
  return Math.max(run.streamingSince - 1, firstAvailable - 1);
}

export function createAgentRunEventStream(userId: string, runId: string, afterSequence = 0) {
  const run = activeAgentRuns.get(runId);
  if (!run || run.userId !== userId) return undefined;

  const currentCursor = run.nextSequence - 1;
  const firstAvailableSequence = run.events[0]?.sequence ?? run.nextSequence;
  if (afterSequence > currentCursor) {
    return jsonError("Event cursor is ahead of the active run.", 400, currentCursor);
  }
  if (afterSequence < firstAvailableSequence - 1) {
    return jsonError("Event replay gap; refresh the session connection.", 409, currentCursor);
  }
  return createRunStream(run, new TextEncoder(), afterSequence);
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
      run.abort();
    } catch {
      // Best effort: a failing abort should not block the others.
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (activeAgentRuns.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function finishAgentRun(run: ActiveAgentRun) {
  if (run.flushTimer !== undefined) {
    clearTimeout(run.flushTimer);
    run.flushTimer = undefined;
  }
  flushRunEvents(run);
  run.finished = true;
  activeAgentRuns.delete(run.runId);
  activeSessionRuns.delete(run.sessionId);
  for (const subscriber of run.subscribers) subscriber.close();
  run.subscribers.clear();
}

export function createRunStream(run: ActiveAgentRun, encoder = new TextEncoder(), afterSequence = 0) {
  let subscriber: RunSubscriber | undefined;
  return new Response(
    new ReadableStream({
      start(controller) {
        let connected = true;
        const nextSubscriber: RunSubscriber = {
          enqueue: (envelope) => {
            if (!connected) return false;
            try {
              controller.enqueue(encoder.encode(JSON.stringify(envelope) + "\n"));
              return true;
            } catch {
              connected = false;
              run.subscribers.delete(nextSubscriber);
              return false;
            }
          },
          close: () => {
            if (!connected) return;
            connected = false;
            try {
              controller.close();
            } catch {
              // The observer can close first. The server-owned run continues.
            }
          },
        };
        subscriber = nextSubscriber;

        for (const envelope of run.events) {
          if (envelope.sequence <= afterSequence) continue;
          if (!nextSubscriber.enqueue(envelope)) return;
        }
        if (run.finished) {
          nextSubscriber.close();
          return;
        }
        run.subscribers.add(nextSubscriber);
      },
      cancel() {
        if (subscriber) run.subscribers.delete(subscriber);
      },
    }),
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-agent-run-id": run.runId,
        "x-agent-event-cursor": String(run.nextSequence - 1),
      },
    },
  );
}

/**
 * Publish an event to every subscriber and to the replay buffer.
 *
 * Consecutive deltas for the same content part are merged and held for
 * `deltaCoalesceMs` first. Any other event flushes them, so the pending buffer
 * can never reorder a delta past the event that ends the part it belongs to.
 */
export function emitRunEvent(run: ActiveAgentRun, event: RunEvent) {
  if (event.type === "message_delta") {
    const pending = run.pendingDelta;
    if (pending && pending.contentIndex === event.contentIndex && pending.field === event.field) {
      pending.delta += event.delta;
    } else {
      flushRunEvents(run);
      run.pendingDelta = { ...event };
    }
    if (run.flushTimer === undefined) {
      run.flushTimer = setTimeout(() => {
        run.flushTimer = undefined;
        flushRunEvents(run);
      }, deltaCoalesceMs);
      // A buffered delta must never be the reason the process stays alive.
      run.flushTimer.unref?.();
    }
    return run.subscribers.size > 0;
  }

  flushRunEvents(run);
  return publishRunEvent(run, event);
}

/** Emit any buffered delta immediately. Safe to call when nothing is pending. */
function flushRunEvents(run: ActiveAgentRun) {
  const pending = run.pendingDelta;
  if (!pending) return;
  run.pendingDelta = undefined;
  publishRunEvent(run, pending);
}

function publishRunEvent(run: ActiveAgentRun, event: RunEvent) {
  const envelope: AgentRunEventEnvelope = { sequence: run.nextSequence++, event };
  if (event.type === "message_start") run.streamingSince = envelope.sequence;
  else if (event.type === "message_end") run.streamingSince = undefined;

  run.events.push(envelope);
  if (run.events.length > maxReplayEvents) run.events.splice(0, run.events.length - maxReplayEvents);

  for (const subscriber of run.subscribers) {
    if (!subscriber.enqueue(envelope)) run.subscribers.delete(subscriber);
  }
  return run.subscribers.size > 0;
}

function jsonError(message: string, status: 400 | 409, eventCursor: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-agent-event-cursor": String(eventCursor),
    },
  });
}
