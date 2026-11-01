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
import {
  applyStreamingEvent,
  isStreamingEvent,
  type AgentRunEvent,
  type SessionConnection,
} from "@carmel-agent/shared";
import { readSessionConnection } from "../services/session-snapshot.ts";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import {
  closePiSession,
  openPiSession,
  readPiSessionBranch,
} from "../services/pi-session-storage.ts";
import { attachTestHarness } from "../effectors/testing/pi-harness.ts";
import { projectRunEvent } from "./run-events.ts";
import { createActiveAgentRun, emitRunEvent, finishAgentRun } from "./run-stream.ts";

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

  const lostBeforePersist: string[] = [];
  const connectionSnapshots: SessionConnection[] = [];

  const unsubscribe = pi.observe(async (event) => {
    const wireEvent = projectRunEvent(event);
    if (!wireEvent) return;
    emitRunEvent(run, wireEvent);
    if (event.type === "message_update" && connectionSnapshots.length < 3) {
      const connection = await readSessionConnection(userId, sessionId);
      if (connection) connectionSnapshots.push(connection);
    }

    if (event.type === "message_end") {
      // A reconnect's snapshot is only safe if Pi persists before it notifies.
      const branch = await transcript(sessionId);
      if (
        !branch.some(
          (message: AgentMessage) =>
            JSON.stringify(message) === JSON.stringify(event.entry.model?.[0]),
        )
      ) {
        lostBeforePersist.push(`sequence ${run.nextSequence - 1}`);
      }
    }
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
    lostBeforePersist,
    connectionSnapshots,
    final: await transcript(sessionId),
  };
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

test("real connection snapshots resume a partial message at their cursor without duplicating it", async () => {
  const { run, connectionSnapshots, final } = await streamTurnRecordingReconnects();
  assert.ok(connectionSnapshots.some((snapshot) => snapshot.runProgress?.streamingMessage));
  for (const snapshot of connectionSnapshots) {
    assert.ok(snapshot.activeRun);
    assert.ok(snapshot.session.messageEntryIds.every((id) => !id.startsWith("pending:")));
    const reopened = new ClientView(snapshot.session.messages);
    reopened.streamingMessage = snapshot.runProgress?.streamingMessage;
    for (const envelope of run.events) {
      if (envelope.sequence > snapshot.activeRun.eventCursor) reopened.apply(envelope.event);
    }
    assert.deepEqual(reopened.onScreen(), JSON.parse(JSON.stringify(final)));
  }
});
