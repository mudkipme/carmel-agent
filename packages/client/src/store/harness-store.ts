import { getModel, getModels, type Api, type Model } from "@earendil-works/pi-ai";
import { create } from "zustand";
import { api, type BootstrapPayload } from "@/lib/api";
import { createClientId } from "@/lib/id";
import type {
  AgentConfig,
  ModelRef,
  PromptTemplate,
  ProviderConfig,
  Session,
  SessionDraft,
  User,
} from "@carmel-agent/shared";

const id = createClientId;

type HarnessStatus = "idle" | "loading" | "ready" | "error";

type HarnessState = {
  status: HarnessStatus;
  error?: string;
  users: User[];
  activeUserId: string;
  agents: AgentConfig[];
  activeAgentId: string;
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  sessions: Session[];
  activeSessionId: string;
  bootstrap: () => Promise<void>;
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
  updateSession: (sessionId: string, patch: Partial<Session>) => Promise<void>;
  refreshSession: (sessionId: string) => Promise<void>;
  forkSession: (sessionId: string, messageIndex: number) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  addPromptTemplate: (agentId: string, template: Omit<PromptTemplate, "id">) => Promise<void>;
  deletePromptTemplate: (agentId: string, templateId: string) => Promise<void>;
};

export const useHarnessStore = create<HarnessState>()((set, get) => ({
  status: "idle",
  users: [],
  activeUserId: "",
  agents: [],
  activeAgentId: "",
  providerConfigs: [],
  modelRefs: [],
  sessions: [],
  activeSessionId: "",
  bootstrap: async () => {
    set({ status: "loading", error: undefined });
    try {
      const payload = await api.bootstrap();
      set(resolveBootstrapState(payload, get()));
    } catch (error) {
      set({ status: "error", error: error instanceof Error ? error.message : "Failed to load harness" });
    }
  },
  setActiveUser: (userId) => {
    const session = get().sessions.find((item) => item.userId === userId);
    const agent =
      get().agents.find((item) => item.id === session?.agentId) ??
      get().agents.find((item) => item.ownerUserId === userId || item.shared);
    set({
      activeUserId: userId,
      activeAgentId: agent?.id ?? "",
      activeSessionId: session?.agentId === agent?.id ? (session?.id ?? "") : "",
    });
  },
  setActiveAgent: (agentId) => {
    const session = get().sessions.find(
      (item) => item.agentId === agentId && item.userId === get().activeUserId,
    );
    set({
      activeAgentId: agentId,
      activeSessionId: session?.id ?? "",
    });
  },
  setActiveSession: (sessionId) => {
    const session = get().sessions.find((item) => item.id === sessionId);
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
    const agent: AgentConfig = {
      id: id("agent"),
      ownerUserId: draft?.ownerUserId ?? get().activeUserId,
      shared: draft?.shared ?? false,
      name: draft?.name ?? "New agent",
      description: draft?.description ?? "Personal agent",
      workingDir: draft?.workingDir ?? "/tmp",
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
      const activeAgentId = state.activeAgentId === agentId ? (agents[0]?.id ?? "") : state.activeAgentId;
      const activeSession = sessions.find(
        (item) => item.agentId === activeAgentId && item.userId === state.activeUserId,
      );
      return {
        agents,
        sessions,
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
    const session = await api.createSession({ ...draft, userId: get().activeUserId });
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeSessionId: session.id,
      activeAgentId: session.agentId,
    }));
    return session;
  },
  updateSession: async (sessionId, patch) => {
    const saved = await api.updateSession(sessionId, patch);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? saved : item)),
    }));
  },
  refreshSession: async (sessionId) => {
    const saved = await api.getSession(sessionId);
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === sessionId ? saved : item)),
    }));
  },
  forkSession: async (sessionId, messageIndex) => {
    const session = await api.forkSession(sessionId, messageIndex);
    set((state) => ({
      sessions: [session, ...state.sessions],
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
      const activeSessionId =
        state.activeSessionId === sessionId
          ? (sessions.find(
              (item) =>
                item.userId === state.activeUserId &&
                item.agentId === (deleted?.agentId ?? state.activeAgentId),
            )?.id ?? "")
          : state.activeSessionId;
      return { sessions, activeSessionId };
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
}));

export function resolveModelRef(modelRef: ModelRef): Model<Api> {
  const builtIn = getModel(modelRef.provider as never, modelRef.modelId as never);
  if (builtIn) {
    return {
      ...builtIn,
    };
  }
  return {
    id: modelRef.modelId,
    name: modelRef.label,
    api: modelRef.api ?? "openai-completions",
    provider: modelRef.provider,
    baseUrl: "",
    reasoning: modelRef.reasoning ?? false,
    input: modelRef.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelRef.contextWindow ?? 128000,
    maxTokens: modelRef.maxTokens ?? 8192,
  } as Model<Api>;
}

export function makeModelRef(provider: string, modelId: string, providerConfigId?: string): ModelRef {
  const model = getModel(provider as never, modelId as never);
  return {
    id: id("model"),
    label: model?.name ?? modelId,
    provider,
    providerConfigId,
    modelId,
    api: model?.api,
    contextWindow: model?.contextWindow,
    maxTokens: model?.maxTokens,
    reasoning: model?.reasoning,
    input: model?.input,
  };
}

export function modelsForProvider(provider: string) {
  return getModels(provider as never);
}

function resolveBootstrapState(
  payload: BootstrapPayload,
  current: Pick<HarnessState, "activeUserId" | "activeAgentId" | "activeSessionId">,
) {
  const activeUserId = payload.users.some((user) => user.id === current.activeUserId)
    ? current.activeUserId
    : (payload.users[0]?.id ?? "");
  const activeSession = payload.sessions.find(
    (session) => session.id === current.activeSessionId && session.userId === activeUserId,
  );
  const activeAgent =
    payload.agents.find((agent) => agent.id === current.activeAgentId) ??
    payload.agents.find((agent) => agent.id === activeSession?.agentId) ??
    payload.agents.find((agent) => agent.ownerUserId === activeUserId || agent.shared);
  const nextActiveSession =
    activeSession?.agentId === activeAgent?.id
      ? activeSession
      : payload.sessions.find((session) => session.userId === activeUserId && session.agentId === activeAgent?.id);

  return {
    ...payload,
    activeUserId,
    activeAgentId: activeAgent?.id ?? "",
    activeSessionId: nextActiveSession?.id ?? "",
    status: "ready" as const,
  };
}
