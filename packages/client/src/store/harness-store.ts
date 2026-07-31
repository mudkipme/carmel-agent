import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { ApiError, api } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { readSessionConnection } from "@/lib/session-connection";
import { resolveModelRef } from "@/store/model-utils";
import type { AgentConfig } from "@carmel-agent/shared";
import { cacheSession, canUserSeeAgent, resetState, resolveBootstrapState, toSessionMetadata } from "@/store/harness-state";
import type { HarnessPersistedState, HarnessState } from "@/store/harness-types";

export {
  defaultBaseUrlForProvider,
  getAppProviders,
  makeModelRef,
  modelsForProvider,
  resolveModelRef,
} from "@/store/model-utils";

const id = createClientId;

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
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        const needsSetup = await api
          .setupStatus()
          .then((status) => status.needsSetup)
          .catch(() => false);
        set((state) => resetState({ status: needsSetup ? "setup" : "unauthenticated" }, state));
        return;
      }
      set({ status: "error", error: error instanceof Error ? error.message : "Failed to load harness" });
    }
  },
  setup: async (input) => {
    set({ status: "loading", error: undefined });
    try {
      const payload = await api.setup(input);
      const nextState = resolveBootstrapState(payload, get());
      set(nextState);
    } catch (error) {
      set((state) => ({
        ...resetState({ status: "setup" }, state),
        error: error instanceof Error ? error.message : "Setup failed",
      }));
    }
  },
  login: async (username, password) => {
    set({ status: "loading", error: undefined });
    try {
      const payload = await api.login(username, password);
      const nextState = resolveBootstrapState(payload, get());
      set(nextState);
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
  updateAccount: async (currentPassword, email, newPassword) => {
    const saved = await api.updateAccount(currentPassword, email, newPassword);
    set((state) => ({ users: state.users.map((item) => (item.id === saved.id ? saved : item)) }));
  },
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
  },
  setActiveSession: (sessionId) => {
    const session = get().sessions.find((item) => item.id === sessionId && item.userId === get().activeUserId);
    if (!session) return;
    set({ activeSessionId: sessionId, activeAgentId: session.agentId });
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
      mounts: draft?.mounts ?? [],
      systemPrompt: draft?.systemPrompt ?? "You are a helpful agent.",
      promptTemplates: draft?.promptTemplates ?? [],
      permissions: draft?.permissions ?? {
        read: true,
        write: true,
        edit: true,
        bash: false,
        network: false,
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
  truncateSessionMessages: async (sessionId, entryId, thinkingLevel) => {
    const saved = await api.truncateSessionMessages(sessionId, entryId, thinkingLevel);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? toSessionMetadata(saved) : item)),
      sessionDetails: { ...state.sessionDetails, [sessionId]: saved },
    }));
    return saved;
  },
  editSessionMessage: async (sessionId, entryId, content, options) => {
    const saved = await api.editSessionMessage(sessionId, entryId, content, options);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? toSessionMetadata(saved) : item)),
      sessionDetails: { ...state.sessionDetails, [sessionId]: saved },
    }));
    return saved;
  },
  connectSession: async (sessionId) => {
    const connection = await readSessionConnection(sessionId);
    set((state) => cacheSession(state, connection.session));
    return connection;
  },
  refreshSession: async (sessionId) => {
    const saved = (await readSessionConnection(sessionId)).session;
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? toSessionMetadata(saved) : item)),
      sessionDetails: { ...state.sessionDetails, [sessionId]: saved },
    }));
    return saved;
  },
  forkSession: async (sessionId, entryId) => {
    const session = await api.forkSession(sessionId, entryId);
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
