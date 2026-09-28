import type { AgentConfig, SessionMetadata } from "@carmel-agent/shared";

/** Which pane fills the main column, and which route is showing it. */
export type ContentView = "chat" | "files" | "changes" | "terminal" | "issues" | "inbox" | "tasks";

export type ShellRouteInput = {
  view: ContentView;
  routeAgentId?: string;
  routeSessionId?: string;
  /** Agents the signed-in user can see. */
  agents: readonly AgentConfig[];
  /** The agent to land on when the URL names none: the last one opened. */
  lastAgentId?: string;
  /** The route's session, once the store has it -- from bootstrap or a lookup. */
  routeSession?: SessionMetadata;
  /** Whether fetching a route session missing from bootstrap has finished. */
  routeSessionLookupDone: boolean;
  userId: string;
};

export type ShellRoute =
  | { kind: "inbox" }
  /** The URL is not a place this user can be; go here instead. */
  | { kind: "redirect"; to: string }
  /** Still finding out whether the URL's session exists. */
  | { kind: "loading" }
  /** No agent to show at all. */
  | { kind: "empty" }
  | { kind: "ready"; agent: AgentConfig; session?: SessionMetadata };

/**
 * Resolve the shell's URL into what it shows, or where it should be instead.
 *
 * The URL is the only source of truth for the open agent and session: nothing
 * else holds a selection that could disagree with it, so there is nothing to
 * sync back and forth. `lastAgentId` is a memory used only when the URL is `/`.
 */
export function resolveShellRoute(input: ShellRouteInput): ShellRoute {
  if (input.view === "inbox") return { kind: "inbox" };
  const { agents, routeAgentId, routeSessionId } = input;

  if (!routeAgentId) {
    const landing = agents.find((agent) => agent.id === input.lastAgentId) ?? agents[0];
    return landing ? { kind: "redirect", to: `/agents/${landing.id}` } : { kind: "empty" };
  }

  const agent = agents.find((candidate) => candidate.id === routeAgentId);
  if (!agent) return { kind: "redirect", to: "/" };

  if (input.view === "terminal" && !canOpenTerminal(agent, input.userId)) {
    return { kind: "redirect", to: `/agents/${agent.id}` };
  }

  if (input.view !== "chat" || !routeSessionId) return { kind: "ready", agent };

  const session = input.routeSession;
  if (!session) {
    return input.routeSessionLookupDone ? { kind: "redirect", to: `/agents/${agent.id}` } : { kind: "loading" };
  }
  // A link can name the right session under the wrong agent; the session wins.
  if (session.agentId !== agent.id) {
    const owner = agents.find((candidate) => candidate.id === session.agentId);
    return { kind: "redirect", to: owner ? sessionPath(session) : `/agents/${agent.id}` };
  }
  return { kind: "ready", agent, session };
}

/** Mirrors the server gate in terminal-socket.ts: the owner, with bash allowed. */
export function canOpenTerminal(agent: AgentConfig, userId: string) {
  return agent.ownerUserId === userId && agent.permissions.bash;
}

export function sessionPath(session: Pick<SessionMetadata, "agentId" | "id">) {
  return `/agents/${session.agentId}/sessions/${session.id}`;
}
