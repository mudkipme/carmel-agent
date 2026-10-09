import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
} from "@earendil-works/pi-ai/providers/faux";
import { applyStreamingEvent, isStreamingEvent, type AgentRunEvent } from "@carmel-agent/shared";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import {
  closePiSession,
  openPiSession,
  readPiSessionBranch,
} from "../services/pi-session-storage.ts";
import { attachTestHarness } from "../effectors/testing/pi-harness.ts";
import { projectRunEvent } from "./run-events.ts";
import {
  createActiveAgentRun,
  emitRunEvent,
  finishAgentRun,
  getActiveAgentRunForSessionId,
} from "./run-stream.ts";

initialize();

// What a client holds on screen: the same folding `RemoteAgent.processEvent` does.
class ClientView {
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;

  constructor(snapshotMessages: AgentMessage[]) {
    this.messages = [...snapshotMessages];
  }

  apply(event: AgentRunEvent) {
    if (isStreamingEvent(event)) {
      this.streamingMessage = applyStreamingEvent(this.streamingMessage, event);
      return;
    }
    if (event.type === "message_end") {
      this.streamingMessage = undefined;
      this.messages = [...this.messages, event.message];
    }
  }

  /** Everything on screen, including the message still being received. */
  onScreen() {
    const all = this.streamingMessage ? [...this.messages, this.streamingMessage] : this.messages;
    // Round-trip: persisted messages have been through JSON and so have dropped
    // the explicit-undefined keys the in-memory ones still carry.
    return JSON.parse(JSON.stringify(all)) as Array<{ role: string; content: unknown }>;
  }
}

/**
 * Stream one real turn, recording what a reconnect would be handed at each point.
 *
 * The recording is deliberately cheap -- reading the attach cursor is synchronous,
 * and the transcript is read only at `message_end`. An earlier version probed the
 * database on every event, and its own latency let the coalescing timer flush the
 * deltas it was trying to observe, so it almost never landed mid-message.
 */
async function streamTurnRecordingReconnects() {
  const { sessionId, userId } = createSession();
  const faux = fauxProvider({
    provider: `faux-reopen-${crypto.randomUUID()}`,
    tokensPerSecond: 120,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("weighing it up, at some length"),
      fauxText("Hello, world. ".repeat(20)),
    ]),
  ]);

  const piSession = await openPiSession(sessionId);
  const run = createActiveAgentRun({
    runId: `run_${sessionId}`,
    userId,
    sessionId,
    abort: () => {},
  });
  const pi = await attachTestHarness(piSession, {
    models,
    model: faux.getModel(),
    systemPrompt: "Test assistant",
  });

  // What `readSessionConnection` would answer, captured as the run produces it.
  const reconnectPoints: Array<{ boundary: number; cursor: number }> = [];
  const persistedAfter: Array<{ sequence: number; messages: AgentMessage[] }> = [];
  const lostBeforePersist: string[] = [];
  let lastBoundary = 0;

  const unsubscribe = pi.observe(async (event) => {
    const wireEvent = projectRunEvent(event);
    if (!wireEvent) return;
    emitRunEvent(run, wireEvent);

    if (event.type === "message_end") {
      // A reconnect's snapshot is only safe if Pi persists before it notifies.
      const branch = await transcript(sessionId);
      if (
        !branch.some(
          (message: AgentMessage) => JSON.stringify(message) === JSON.stringify(event.message),
        )
      ) {
        lostBeforePersist.push(`sequence ${run.nextSequence - 1}`);
      }
      persistedAfter.push({ sequence: run.nextSequence - 1, messages: branch });
    }

    // The coalescing timer publishes between subscriber calls, so probe whenever
    // the stream has moved rather than only when this event published something.
    const boundary = run.nextSequence - 1;
    if (boundary <= lastBoundary) return;
    lastBoundary = boundary;
    reconnectPoints.push({
      boundary,
      cursor: getActiveAgentRunForSessionId(sessionId)!.eventCursor,
    });
  });

  try {
    await pi.lane.prompt("hello", undefined, pi.context);
  } finally {
    unsubscribe();
    finishAgentRun(run);
    await pi.close();
  }

  return {
    run,
    reconnectPoints,
    persistedAfter,
    lostBeforePersist,
    final: await transcript(sessionId),
  };
}

/**
 * The messages a reconnect's snapshot holds at `boundary`.
 *
 * Pi Durable commits messages before announcing their `message_end`. Reads
 * include committed live progress, so a reconnect also sees the reply in flight.
 */
function snapshotAt(
  persistedAfter: Array<{ sequence: number; messages: AgentMessage[] }>,
  boundary: number,
) {
  let messages: AgentMessage[] = [];
  for (const entry of persistedAfter) {
    if (entry.sequence <= boundary) messages = entry.messages;
  }
  return messages;
}

/** Compact shape of what is on screen, so a divergence names itself. */
function summarize(view: ClientView) {
  return view
    .onScreen()
    .map((message) => {
      const parts = Array.isArray(message.content)
        ? message.content
        : [{ type: "raw", text: message.content }];
      const shape = (parts as Array<{ type: string; text?: string; thinking?: string }>)
        .map((part) => `${part.type}:${(part.text ?? part.thinking ?? "").length}`)
        .join(",");
      return `${message.role}[${shape}]`;
    })
    .join(" | ");
}

async function transcript(sessionId: string): Promise<AgentMessage[]> {
  const session = await openPiSession(sessionId);
  try {
    return (await readPiSessionBranch(session)).flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );
  } finally {
    await closePiSession(session);
  }
}

/**
 * A reconnect must never receive a cursor past a finished message absent from
 * its snapshot, including the final message of a turn.
 */
test("every message_end is persisted before it reaches a subscriber", async () => {
  const { lostBeforePersist } = await streamTurnRecordingReconnects();
  assert.deepEqual(lostBeforePersist, []);
});

test("reopening mid-stream shows exactly what a session that stayed open shows", async () => {
  const { run, reconnectPoints, persistedAfter, final } = await streamTurnRecordingReconnects();

  const divergences: Array<{ renderedTheSame: boolean; detail: string }> = [];
  let midMessageProbes = 0;

  for (const { boundary, cursor } of reconnectPoints) {
    const stayedOpen = new ClientView([]);
    const reopened = new ClientView(snapshotAt(persistedAfter, boundary));
    for (const envelope of run.events) {
      if (envelope.sequence > boundary) continue;
      stayedOpen.apply(envelope.event);
      if (envelope.sequence > cursor) reopened.apply(envelope.event);
    }

    // The probes that prove something: partway through a message, where the
    // reopened client must rebuild content it never received live.
    if (reopened.streamingMessage) midMessageProbes += 1;
    if (JSON.stringify(reopened.onScreen()) !== JSON.stringify(stayedOpen.onScreen())) {
      const rendered = summarize(reopened) === summarize(stayedOpen);
      divergences.push({
        // Content-identical divergences are the settle window: the message is
        // all there, but its metadata is still the in-flight copy's.
        renderedTheSame: rendered,
        detail: `at sequence ${boundary} (cursor ${cursor}) reopened=${summarize(reopened)} stayedOpen=${summarize(stayedOpen)}`,
      });
    }
  }

  // What still holds, and is what the user sees: a reopened session never
  // renders anything different from one that stayed open. Reading the snapshot
  // from the lane rather than the branch is what buys this -- the branch alone
  // would be missing the whole in-flight reply.
  //
  // What no longer holds is byte-identity. Inside the settle window the reopened
  // client holds the in-flight copy of the last message, whose `stopReason` and
  // usage Pi fills in when the operation commits. Same content, later metadata.
  const renderedDifferently = divergences
    .filter((entry) => !entry.renderedTheSame)
    .map((entry) => entry.detail);
  assert.deepEqual(
    renderedDifferently,
    [],
    "a reopened session must render the same thing as one that stayed open",
  );
  // Without mid-message probes the check above would prove nothing: the closing
  // `message_end` is authoritative and heals any reconnect by itself.
  assert.ok(midMessageProbes >= 3, `the turn must be probed mid-message (got ${midMessageProbes})`);

  const fromStream = new ClientView([]);
  for (const envelope of run.events) fromStream.apply(envelope.event);
  assert.deepEqual(
    fromStream.onScreen(),
    JSON.parse(JSON.stringify(final)),
    "the stream must fold to the persisted transcript",
  );
});
