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
  return { ...command, codemodeEnabled: command.codemodeEnabled ?? false, mcpServers: command.mcpServers ?? [] };
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
 * Whether a session belongs in the session list. A task run's, an issue's, or
 * an archived session can be in the store because it is open, but each is
 * reached from somewhere else, so it never counts as one of the agent's listed
 * sessions.
 */
export function isListedSession(session: SessionMetadata) {
  return !session.taskId && !session.issueId && !session.archivedAt;
}

export function cacheSession(state: HarnessState, session: Session) {
  return {
    sessions: state.sessions.map((item) => (item.id === session.id ? toSessionMetadata(session) : item)),
    sessionDetails: { ...state.sessionDetails, [session.id]: session },
  };
}

export function resetState(
  patch: Pick<HarnessState, "status"> & Partial<Pick<HarnessState, "error">>,
  preserve?: HarnessPersistedState,
) {
  return {
    ...patch,
    users: [],
    activeUserId: "",
    agents: [],
    lastAgentId: preserve?.lastAgentId ?? "",
    providerConfigs: [],
    modelRefs: [],
    modelCatalog: { providers: [] },
    sessions: [],
    sessionDetails: {},
    issues: [],
  };
}

/** Bootstrap returns exactly the signed-in user, with what they can see. */
export function resolveBootstrapState(payload: BootstrapPayload, current: Pick<HarnessState, "sessionDetails">) {
  const activeUserId = payload.users[0]?.id ?? "";
  const sessions = payload.sessions.filter((session) => session.userId === activeUserId);
  const agents = payload.agents.filter((agent) => canUserSeeAgent(agent, activeUserId));
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
    status: "ready" as const,
  };
}

export function canUserSeeAgent(agent: AgentConfig, userId: string) {
  return agent.ownerUserId === userId || agent.shared;
}

function mergeSessionMetadata(session: Session, metadata: SessionMetadata): Session {
  return { ...metadata, messages: session.messages, messageEntryIds: session.messageEntryIds };
}
