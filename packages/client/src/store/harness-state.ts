import type { BootstrapPayload } from "@/lib/api";
import type { HarnessPersistedState, HarnessState } from "@/store/harness-types";
import type { AgentConfig, Session, SessionMetadata } from "@carmel-agent/shared";

export function cacheSession(state: HarnessState, session: Session) {
  return {
    sessions: state.sessions.map((item) => (item.id === session.id ? toSessionMetadata(session) : item)),
    sessionDetails: { ...state.sessionDetails, [session.id]: session },
  };
}

export function resetState(
  patch: Pick<HarnessState, "status"> & Partial<Pick<HarnessState, "error">>,
  preserveSelection?: HarnessPersistedState,
) {
  return {
    ...patch,
    users: [],
    activeUserId: preserveSelection?.activeUserId ?? "",
    agents: [],
    activeAgentId: preserveSelection?.activeAgentId ?? "",
    providerConfigs: [],
    modelRefs: [],
    sessions: [],
    sessionDetails: {},
    activeSessionId: preserveSelection?.activeSessionId ?? "",
  };
}

export function resolveBootstrapState(
  payload: BootstrapPayload,
  current: Pick<HarnessState, "activeUserId" | "activeAgentId" | "activeSessionId" | "sessionDetails">,
) {
  const activeUserId = payload.users.some((user) => user.id === current.activeUserId)
    ? current.activeUserId
    : (payload.users[0]?.id ?? "");
  const sessions = payload.sessions.filter((session) => session.userId === activeUserId);
  const agents = payload.agents.filter((agent) => canUserSeeAgent(agent, activeUserId));
  const activeSession = sessions.find(
    (session) => session.id === current.activeSessionId && session.userId === activeUserId,
  );
  const activeAgent =
    agents.find((agent) => agent.id === current.activeAgentId) ??
    agents.find((agent) => agent.id === activeSession?.agentId) ??
    agents.find((agent) => agent.ownerUserId === activeUserId || agent.shared);
  const nextActiveSession =
    activeSession?.agentId === activeAgent?.id
      ? activeSession
      : sessions.find((session) => session.agentId === activeAgent?.id);
  const sessionDetails = Object.fromEntries(
    sessions.flatMap((metadata) => {
      const detail = current.sessionDetails[metadata.id];
      return detail ? [[metadata.id, mergeSessionMetadata(detail, metadata)] as const] : [];
    }),
  );
  return {
    ...payload,
    agents,
    sessions,
    sessionDetails,
    activeUserId,
    activeAgentId: activeAgent?.id ?? "",
    activeSessionId: nextActiveSession?.id ?? "",
    status: "ready" as const,
  };
}

export function toSessionMetadata(session: Session): SessionMetadata {
  return {
    id: session.id,
    title: session.title,
    userId: session.userId,
    agentId: session.agentId,
    modelRefId: session.modelRefId,
    thinkingLevel: session.thinkingLevel,
    revision: session.revision,
    forkedFrom: session.forkedFrom,
    pinnedAt: session.pinnedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

export function canUserSeeAgent(agent: AgentConfig, userId: string) {
  return agent.ownerUserId === userId || agent.shared;
}

function mergeSessionMetadata(session: Session, metadata: SessionMetadata): Session {
  return { ...metadata, messages: session.messages };
}
