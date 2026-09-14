import type { BootstrapPayload } from "@/lib/api";
import type { HarnessPersistedState, HarnessState } from "@/store/harness-types";
import { toSessionMetadata } from "@carmel-agent/shared";
import type {
  AgentConfig,
  AgentConfigCommand,
  ModelRef,
  ModelRefCommand,
  ProviderConfig,
  ProviderConfigCommand,
  Session,
  SessionMetadata,
} from "@carmel-agent/shared";

export function upsertById<T extends { id: string }>(items: T[], saved: T) {
  return items.some((item) => item.id === saved.id)
    ? items.map((item) => (item.id === saved.id ? saved : item))
    : [...items, saved];
}

export function toAgentCommand(agent: AgentConfig): AgentConfigCommand {
  const { id: _id, ownerUserId: _ownerUserId, createdAt: _createdAt, updatedAt: _updatedAt, ...command } = agent;
  return command;
}

export function toModelRefCommand(model: ModelRef): ModelRefCommand {
  const { id: _id, ownerUserId: _ownerUserId, ...command } = model;
  return command;
}

export function toProviderConfigCommand(providerConfig: ProviderConfig): ProviderConfigCommand {
  return {
    label: providerConfig.label,
    provider: providerConfig.provider,
    authType: providerConfig.authType,
    apiKey: providerConfig.apiKey,
    baseUrl: providerConfig.baseUrl,
  };
}

/**
 * Whether a session belongs in the session list. A task run's session can be in
 * the store because it is open, but it is reached from the task's run history,
 * so it never counts as one of the agent's listed sessions.
 */
export function isListedSession(session: SessionMetadata) {
  return !session.taskId;
}

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
    modelCatalog: { providers: [] },
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
      : sessions.find((session) => session.agentId === activeAgent?.id && isListedSession(session));
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

export function canUserSeeAgent(agent: AgentConfig, userId: string) {
  return agent.ownerUserId === userId || agent.shared;
}

function mergeSessionMetadata(session: Session, metadata: SessionMetadata): Session {
  return { ...metadata, messages: session.messages, messageEntryIds: session.messageEntryIds };
}
