import test from "node:test";
import assert from "node:assert/strict";
import type { Session, SessionMetadata } from "@carmel-agent/shared";
import type { BootstrapPayload } from "../lib/api.ts";
import { resolveBootstrapState } from "./harness-state.ts";

const me = "user_me";

function session(id: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id,
    title: id,
    userId: me,
    agentId: "agent_a",
    modelRefId: "model_a",
    thinkingLevel: "off",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function open(metadata: SessionMetadata): Session {
  return { ...metadata, messages: [], messageEntryIds: [] };
}

function payload(sessions: SessionMetadata[]): BootstrapPayload {
  return {
    users: [{ id: me, name: "Me", email: "me@example.test", role: "user" }],
    agents: [],
    providerConfigs: [],
    modelRefs: [],
    modelCatalog: { providers: [] },
    sessions,
  };
}

test("a refresh keeps a task session the open route fetched outside bootstrap", () => {
  const task = open(session("task_run", { taskId: "agent_task_1" }));
  const state = resolveBootstrapState(payload([session("listed")]), {
    sessionDetails: { [task.id]: task },
  });

  assert.deepEqual(
    state.sessions.map((item) => item.id),
    ["listed", "task_run"],
  );
  assert.equal(state.sessionDetails[task.id]?.messages.length, 0);
});

test("a listed session that bootstrap no longer returns is dropped", () => {
  const gone = open(session("gone"));
  const state = resolveBootstrapState(payload([]), {
    sessionDetails: { [gone.id]: gone },
  });

  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.sessionDetails, {});
});

test("a refresh keeps the archived session the settings page opened", () => {
  const archived = open(session("archived", { archivedAt: 5 }));
  const state = resolveBootstrapState(payload([]), {
    sessionDetails: { [archived.id]: archived },
  });

  assert.deepEqual(
    state.sessions.map((item) => item.id),
    ["archived"],
  );
});
