import type { AgentEvent } from "@earendil-works/pi-agent-core";

const maxReplayEvents = 1_000;

export type RunEvent = AgentEvent | { type: string; [key: string]: unknown };

export type ActiveAgentRun = {
  runId: string;
  userId: string;
  sessionId: string;
  abort: () => void;
  events: RunEvent[];
  subscribers: Set<RunSubscriber>;
  finished: boolean;
  started: boolean;
};

type RunSubscriber = {
  enqueue: (event: RunEvent) => boolean;
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
  const runId = activeSessionRuns.get(sessionId);
  if (!runId) return undefined;
  const run = activeAgentRuns.get(runId);
  if (!run || run.userId !== userId || run.sessionId !== sessionId) return undefined;
  return { runId: run.runId, sessionId: run.sessionId };
}

export function createAgentRunEventStream(userId: string, runId: string) {
  const run = activeAgentRuns.get(runId);
  if (!run || run.userId !== userId) return undefined;
  return createRunStream(run);
}

// Abort every in-flight run and wait for their finally blocks to persist
// messages, so a restart does not lose an active turn. Resolves once all runs
// have drained or the timeout elapses.
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
  run.finished = true;
  activeAgentRuns.delete(run.runId);
  activeSessionRuns.delete(run.sessionId);
  for (const subscriber of run.subscribers) subscriber.close();
  run.subscribers.clear();
}

export function createRunStream(run: ActiveAgentRun, encoder = new TextEncoder()) {
  let subscriber: RunSubscriber | undefined;
  return new Response(
    new ReadableStream({
      start(controller) {
        let connected = true;
        const nextSubscriber: RunSubscriber = {
          enqueue: (event) => {
            if (!connected) return false;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
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
              // The browser can close first.
            }
          },
        };
        subscriber = nextSubscriber;

        for (const event of run.events) {
          if (!nextSubscriber.enqueue(event)) return;
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
      },
    },
  );
}

export function emitRunEvent(run: ActiveAgentRun, event: RunEvent) {
  run.events.push(event);
  if (run.events.length > maxReplayEvents) run.events.splice(0, run.events.length - maxReplayEvents);

  for (const subscriber of run.subscribers) {
    if (!subscriber.enqueue(event)) run.subscribers.delete(subscriber);
  }
  return run.subscribers.size > 0;
}
