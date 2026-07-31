import test from "node:test";
import assert from "node:assert/strict";
import type { SessionConnection } from "@carmel-agent/shared";
import { readSessionConnection } from "./session-connection.ts";

test("concurrent reads for one session share a single connection request", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let release: (() => void) | undefined;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    if (requests.length === 1) {
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return Response.json(connection("session_1"));
  };

  try {
    const first = readSessionConnection("session_1");
    const second = readSessionConnection("session_1");
    assert.equal(first, second);
    assert.deepEqual(requests, ["/api/sessions/session_1/connection"]);

    release?.();
    assert.deepEqual(await first, connection("session_1"));

    await readSessionConnection("session_1");
    assert.deepEqual(requests, [
      "/api/sessions/session_1/connection",
      "/api/sessions/session_1/connection",
    ]);
  } finally {
    release?.();
    globalThis.fetch = originalFetch;
  }
});

function connection(sessionId: string): SessionConnection {
  return {
    session: {
      id: sessionId,
      title: "Test",
      userId: "user_1",
      agentId: "agent_1",
      modelRefId: "model_1",
      thinkingLevel: "off",
      revision: 0,
      messages: [],
      messageEntryIds: [],
      createdAt: 1,
      updatedAt: 1,
    },
    activeRun: null,
  };
}
