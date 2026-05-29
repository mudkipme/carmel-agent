import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { ApiError, api, type BootstrapPayload, type SessionPatch } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { resolveModelRef } from "@/store/model-utils";
import {
  type AgentConfig,
  type ModelRef,
  type PromptTemplate,
  type ProviderConfig,
  type Session,
  type SessionDraft,
  type SessionMetadata,
  type User,
} from "@carmel-agent/shared";

export {
  defaultBaseUrlForProvider,
  getAppProviders,
  makeModelRef,
  modelsForProvider,
  resolveModelRef,
} from "@/store/model-utils";

const id = createClientId;

type HarnessStatus = "idle" | "loading" | "ready" | "unauthenticated" | "error";

type HarnessState = {
  status: HarnessStatus;
  error?: string;
  users: User[];
  activeUserId: string;
  agents: AgentConfig[];
  activeAgentId: string;
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  sessions: SessionMetadata[];
  sessionDetails: Record<string, Session>;
  activeSessionId: string;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  setActiveUser: (userId: string) => void;
  setActiveAgent: (agentId: string) => void;
  setActiveSession: (sessionId: string) => void;
  upsertUser: (user: User) => Promise<void>;
  upsertAgent: (agent: AgentConfig) => Promise<void>;
  createAgent: (draft?: Partial<AgentConfig>) => Promise<AgentConfig>;
  deleteAgent: (agentId: string) => Promise<void>;
  upsertProviderConfig: (providerConfig: ProviderConfig) => Promise<void>;
  deleteProviderConfig: (providerConfigId: string) => Promise<void>;
  upsertModelRef: (model: ModelRef) => Promise<ModelRef>;
  deleteModelRef: (modelRefId: string) => Promise<void>;
  createSession: (draft: SessionDraft) => Promise<Session>;
  importOpenWebuiSessions: (draft: SessionDraft & { source: unknown }) => Promise<Session[]>;
  updateSession: (sessionId: string, patch: SessionPatch) => Promise<void>;
  truncateSessionMessages: (sessionId: string, messageIndex: number, thinkingLevel?: Session["thinkingLevel"]) => Promise<Session>;
  editSessionMessage: (
    sessionId: string,
    messageIndex: number,
    content: string,
    options?: { truncate?: boolean; thinkingLevel?: Session["thinkingLevel"] },
  ) => Promise<Session>;
  refreshSession: (sessionId: string) => Promise<void>;
  forkSession: (sessionId: string, messageIndex: number) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  addPromptTemplate: (agentId: string, template: Omit<PromptTemplate, "id">) => Promise<void>;
  deletePromptTemplate: (agentId: string, templateId: string) => Promise<void>;
};

type HarnessPersistedState = Pick<HarnessState, "activeUserId" | "activeAgentId" | "activeSessionId">;

export const useHarnessStore = create<HarnessState>()(
  persist<HarnessState, [], [], HarnessPersistedState>(
    (set, get) => ({
  status: "idle",
  users: [],
  activeUserId: "",
  agents: [],
  activeAgentId: "",
  providerConfigs: [],
  modelRefs: [],
  sessions: [],
  sessionDetails: {},
  activeSessionId: "",
  bootstrap: async () => {
    set({ status: "loading", error: undefined });
    try {
      const payload = await api.bootstrap();
      const nextState = resolveBootstrapState(payload, get());
      set(nextState);
      if (nextState.activeSessionId) await get().refreshSession(nextState.activeSessionId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        set((state) => resetState({ status: "unauthenticated" }, state));
        return;
      }
      set({ status: "error", error: error instanceof Error ? error.message : "Failed to load harness" });
    }
  },
  login: async (username, password) => {
    set({ status: "loading", error: undefined });
    try {
      const payload = await api.login(username, password);
      const nextState = resolveBootstrapState(payload, get());
      set(nextState);
      if (nextState.activeSessionId) await get().refreshSession(nextState.activeSessionId);
    } catch (error) {
      set((state) => ({
        ...resetState({ status: "unauthenticated" }, state),
        error: error instanceof Error ? error.message : "Login failed",
      }));
    }
  },
  logout: async () => {
    await api.logout();
    set(resetState({ status: "unauthenticated" }));
  },
  changePassword: (currentPassword, newPassword) => api.changePassword(currentPassword, newPassword).then(() => undefined),
  setActiveUser: (userId) => {
    const session = get().sessions.find((item) => item.userId === userId);
    const agent =
      get().agents.find((item) => item.id === session?.agentId && canUserSeeAgent(item, userId)) ??
      get().agents.find((item) => item.ownerUserId === userId || item.shared);
    const activeSessionId = session?.agentId === agent?.id ? (session?.id ?? "") : "";
    set({
      activeUserId: userId,
      activeAgentId: agent?.id ?? "",
      activeSessionId,
    });
    if (activeSessionId && !get().sessionDetails[activeSessionId]) void get().refreshSession(activeSessionId);
  },
  setActiveAgent: (agentId) => {
    const agent = get().agents.find((item) => item.id === agentId && canUserSeeAgent(item, get().activeUserId));
    if (!agent) return;
    const session = get().sessions.find(
      (item) => item.agentId === agentId && item.userId === get().activeUserId,
    );
    set({
      activeAgentId: agentId,
      activeSessionId: session?.id ?? "",
    });
    if (session?.id && !get().sessionDetails[session.id]) void get().refreshSession(session.id);
  },
  setActiveSession: (sessionId) => {
    const session = get().sessions.find((item) => item.id === sessionId && item.userId === get().activeUserId);
    if (!session) return;
    set({ activeSessionId: sessionId, activeAgentId: session.agentId });
    if (!get().sessionDetails[sessionId]) void get().refreshSession(sessionId);
  },
  upsertUser: async (user) => {
    const saved = await api.upsertUser(user);
    set((state) => ({
      users: state.users.some((item) => item.id === saved.id)
        ? state.users.map((item) => (item.id === saved.id ? saved : item))
        : [...state.users, saved],
    }));
  },
  upsertAgent: async (agent) => {
    const saved = await api.upsertAgent({ ...agent, updatedAt: Date.now() });
    set((state) => ({
      agents: state.agents.some((item) => item.id === saved.id)
        ? state.agents.map((item) => (item.id === saved.id ? saved : item))
        : [...state.agents, saved],
    }));
  },
  createAgent: async (draft) => {
    const timestamp = Date.now();
    const defaultModelRefId = draft?.defaultModelRefId ?? get().modelRefs[0]?.id;
    if (!defaultModelRefId) throw new Error("Create a model before creating an agent.");
    const defaultModelRef = get().modelRefs.find((model) => model.id === defaultModelRefId);
    const defaultThinkingLevel = defaultModelRef
      ? clampThinkingLevel(resolveModelRef(defaultModelRef), draft?.defaultThinkingLevel ?? "off")
      : "off";
    const agent: AgentConfig = {
      id: id("agent"),
      ownerUserId: draft?.ownerUserId ?? get().activeUserId,
      shared: draft?.shared ?? false,
      name: draft?.name ?? "New agent",
      description: draft?.description ?? "Personal agent",
      workingDirMode: draft?.workingDirMode ?? "default",
      workingDir: draft?.workingDir ?? "",
      defaultWorkingDir: draft?.defaultWorkingDir,
      skills: draft?.skills ?? [],
      systemPrompt: draft?.systemPrompt ?? "You are a helpful agent.",
      promptTemplates: draft?.promptTemplates ?? [],
      permissions: draft?.permissions ?? {
        read: true,
        write: true,
        edit: true,
        bash: false,
        network: false,
        javascript: true,
        artifacts: true,
        documentExtract: true,
      },
      defaultModelRefId,
      defaultThinkingLevel,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const saved = await api.upsertAgent(agent);
    set((state) => ({
      agents: [...state.agents, saved],
      activeAgentId: saved.id,
      activeSessionId: "",
    }));
    return saved;
  },
  deleteAgent: async (agentId) => {
    await api.deleteAgent(agentId);
    set((state) => {
      const agents = state.agents.filter((item) => item.id !== agentId);
      const sessions = state.sessions.filter((item) => item.agentId !== agentId);
      const deletedSessionIds = new Set(state.sessions.filter((item) => item.agentId === agentId).map((item) => item.id));
      const sessionDetails = Object.fromEntries(
        Object.entries(state.sessionDetails).filter(([sessionId]) => !deletedSessionIds.has(sessionId)),
      );
      const activeAgentId = state.activeAgentId === agentId ? (agents[0]?.id ?? "") : state.activeAgentId;
      const activeSession = sessions.find(
        (item) => item.agentId === activeAgentId && item.userId === state.activeUserId,
      );
      return {
        agents,
        sessions,
        sessionDetails,
        activeAgentId,
        activeSessionId: state.activeAgentId === agentId ? (activeSession?.id ?? "") : state.activeSessionId,
      };
    });
  },
  upsertProviderConfig: async (providerConfig) => {
    const saved = await api.upsertProviderConfig({ ...providerConfig, updatedAt: Date.now() });
    set((state) => ({
      providerConfigs: state.providerConfigs.some((item) => item.id === saved.id)
        ? state.providerConfigs.map((item) => (item.id === saved.id ? saved : item))
        : [...state.providerConfigs, saved],
    }));
  },
  deleteProviderConfig: async (providerConfigId) => {
    const payload = await api.deleteProviderConfig(providerConfigId);
    set((state) => resolveBootstrapState(payload, state));
  },
  upsertModelRef: async (model) => {
    const saved = await api.upsertModelRef(model);
    set((state) => ({
      modelRefs: state.modelRefs.some((item) => item.id === saved.id)
        ? state.modelRefs.map((item) => (item.id === saved.id ? saved : item))
        : [...state.modelRefs, saved],
    }));
    return saved;
  },
  deleteModelRef: async (modelRefId) => {
    const payload = await api.deleteModelRef(modelRefId);
    set((state) => resolveBootstrapState(payload, state));
  },
  createSession: async (draft) => {
    const session = await api.createSession(draft);
    set((state) => ({
      sessions: [toSessionMetadata(session), ...state.sessions],
      sessionDetails: { ...state.sessionDetails, [session.id]: session },
      activeSessionId: session.id,
      activeAgentId: session.agentId,
    }));
    return session;
  },
  importOpenWebuiSessions: async (draft) => {
    const result = await api.importOpenWebuiSessions(draft);
    const importedSessions = result.sessions;
    const firstSession = importedSessions[0];
    set((state) => ({
      sessions: [...importedSessions.map(toSessionMetadata), ...state.sessions],
      sessionDetails: {
        ...state.sessionDetails,
        ...Object.fromEntries(importedSessions.map((session) => [session.id, session])),
      },
      activeSessionId: firstSession?.id ?? state.activeSessionId,
      activeAgentId: firstSession?.agentId ?? state.activeAgentId,
    }));
    return importedSessions;
  },
  updateSession: async (sessionId, patch) => {
    const saved = await api.updateSession(sessionId, patch);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? toSessionMetadata(saved) : item)),
      sessionDetails: { ...state.sessionDetails, [sessionId]: saved },
    }));
  },
  truncateSessionMessages: async (sessionId, messageIndex, thinkingLevel) => {
    const saved = await api.truncateSessionMessages(sessionId, messageIndex, thinkingLevel);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? toSessionMetadata(saved) : item)),
      sessionDetails: { ...state.sessionDetails, [sessionId]: saved },
    }));
    return saved;
  },
  editSessionMessage: async (sessionId, messageIndex, content, options) => {
    const saved = await api.editSessionMessage(sessionId, messageIndex, content, options);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? toSessionMetadata(saved) : item)),
      sessionDetails: { ...state.sessionDetails, [sessionId]: saved },
    }));
    return saved;
  },
  refreshSession: async (sessionId) => {
    const saved = await api.getSession(sessionId);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? toSessionMetadata(saved) : item)),
      sessionDetails: { ...state.sessionDetails, [sessionId]: saved },
    }));
  },
  forkSession: async (sessionId, messageIndex) => {
    const session = await api.forkSession(sessionId, messageIndex);
    set((state) => ({
      sessions: [toSessionMetadata(session), ...state.sessions],
      sessionDetails: { ...state.sessionDetails, [session.id]: session },
      activeSessionId: session.id,
      activeAgentId: session.agentId,
    }));
    return session;
  },
  deleteSession: async (sessionId) => {
    await api.deleteSession(sessionId);
    set((state) => {
      const deleted = state.sessions.find((item) => item.id === sessionId);
      const sessions = state.sessions.filter((item) => item.id !== sessionId);
      const sessionDetails = { ...state.sessionDetails };
      delete sessionDetails[sessionId];
      const activeSessionId =
        state.activeSessionId === sessionId
          ? (sessions.find(
              (item) =>
                item.userId === state.activeUserId &&
                item.agentId === (deleted?.agentId ?? state.activeAgentId),
            )?.id ?? "")
          : state.activeSessionId;
      return { sessions, sessionDetails, activeSessionId };
    });
  },
  addPromptTemplate: async (agentId, template) => {
    const agent = get().agents.find((item) => item.id === agentId);
    if (!agent) return;
    await get().upsertAgent({
      ...agent,
      promptTemplates: [...agent.promptTemplates, { ...template, id: id("template") }],
    });
  },
  deletePromptTemplate: async (agentId, templateId) => {
    const agent = get().agents.find((item) => item.id === agentId);
    if (!agent) return;
    await get().upsertAgent({
      ...agent,
      promptTemplates: agent.promptTemplates.filter((template) => template.id !== templateId),
    });
  },
}),
    {
      name: "carmel-harness-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        activeUserId: state.activeUserId,
        activeAgentId: state.activeAgentId,
        activeSessionId: state.activeSessionId,
      }),
      version: 1,
    },
  ),
);

function resetState(
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

function resolveBootstrapState(
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

function toSessionMetadata(session: Session): SessionMetadata {
  return {
    id: session.id,
    title: session.title,
    userId: session.userId,
    agentId: session.agentId,
    modelRefId: session.modelRefId,
    thinkingLevel: session.thinkingLevel,
    forkedFrom: session.forkedFrom,
    pinnedAt: session.pinnedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
}

function mergeSessionMetadata(session: Session, metadata: SessionMetadata): Session {
  return {
    id: metadata.id,
    title: metadata.title,
    userId: metadata.userId,
    agentId: metadata.agentId,
    modelRefId: metadata.modelRefId,
    thinkingLevel: metadata.thinkingLevel,
    forkedFrom: metadata.forkedFrom,
    pinnedAt: metadata.pinnedAt,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    messages: session.messages,
  };
}

function canUserSeeAgent(agent: AgentConfig, userId: string) {
  return agent.ownerUserId === userId || agent.shared;
}
