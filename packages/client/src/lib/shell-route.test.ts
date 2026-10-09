import test from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig, SessionMetadata } from "@carmel-agent/shared";
import { resolveShellRoute, type ShellRouteInput } from "./shell-route.ts";

const me = "user_me";
const agentA = agent("agent_a", { ownerUserId: me, bash: true });
const agentB = agent("agent_b", { ownerUserId: "someone_else", bash: true });

function input(overrides: Partial<ShellRouteInput>): ShellRouteInput {
  return {
    view: "chat",
    agents: [agentA, agentB],
    routeSessionLookupDone: false,
    userId: me,
    ...overrides,
  };
}

test("the bare root lands on the last agent opened, else the first", () => {
  assert.deepEqual(resolveShellRoute(input({ lastAgentId: "agent_b" })), {
    kind: "redirect",
    to: "/agents/agent_b",
  });
  assert.deepEqual(resolveShellRoute(input({ lastAgentId: "gone" })), {
    kind: "redirect",
    to: "/agents/agent_a",
  });
  assert.deepEqual(resolveShellRoute(input({ agents: [] })), { kind: "empty" });
});

test("an agent the user cannot see goes back to the root", () => {
  assert.deepEqual(resolveShellRoute(input({ routeAgentId: "agent_hidden" })), {
    kind: "redirect",
    to: "/",
  });
});

test("an agent's own path is its new-session composer", () => {
  assert.deepEqual(resolveShellRoute(input({ routeAgentId: "agent_a" })), {
    kind: "ready",
    agent: agentA,
  });
});

test("a session waits for its lookup, then opens or falls back to the composer", () => {
  const base = { routeAgentId: "agent_a", routeSessionId: "s1" };
  assert.deepEqual(resolveShellRoute(input(base)), { kind: "loading" });
  assert.deepEqual(resolveShellRoute(input({ ...base, routeSessionLookupDone: true })), {
    kind: "redirect",
    to: "/agents/agent_a",
  });
  const s1 = session("s1", "agent_a");
  assert.deepEqual(resolveShellRoute(input({ ...base, routeSession: s1 })), {
    kind: "ready",
    agent: agentA,
    session: s1,
  });
});

test("a session linked under the wrong agent moves to its own", () => {
  const s1 = session("s1", "agent_b");
  assert.deepEqual(
    resolveShellRoute(input({ routeAgentId: "agent_a", routeSessionId: "s1", routeSession: s1 })),
    {
      kind: "redirect",
      to: "/agents/agent_b/sessions/s1",
    },
  );
});

test("the terminal is only offered to the owner of an agent that allows bash", () => {
  assert.equal(
    resolveShellRoute(input({ view: "terminal", routeAgentId: "agent_a" })).kind,
    "ready",
  );
  assert.deepEqual(resolveShellRoute(input({ view: "terminal", routeAgentId: "agent_b" })), {
    kind: "redirect",
    to: "/agents/agent_b",
  });
});

test("files and issues belong to the agent, whatever session the URL does not name", () => {
  assert.deepEqual(resolveShellRoute(input({ view: "files", routeAgentId: "agent_b" })), {
    kind: "ready",
    agent: agentB,
  });
  assert.deepEqual(resolveShellRoute(input({ view: "issues", routeAgentId: "agent_a" })), {
    kind: "ready",
    agent: agentA,
  });
});

function agent(id: string, options: { ownerUserId: string; bash: boolean }) {
  return {
    id,
    ownerUserId: options.ownerUserId,
    shared: true,
    permissions: { read: true, write: true, edit: true, bash: options.bash, network: false },
  } as AgentConfig;
}

function session(id: string, agentId: string) {
  return { id, agentId, userId: me, title: id, updatedAt: 1, createdAt: 1 } as SessionMetadata;
}
