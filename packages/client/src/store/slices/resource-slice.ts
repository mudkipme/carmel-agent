import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { StoreApi } from "zustand";
import { api } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { resolveModelRef } from "@/store/model-utils";
import {
  isListedSession,
  resolveBootstrapState,
  toAgentCommand,
  toModelRefCommand,
  toProviderConfigCommand,
  upsertById,
} from "@/store/harness-state";
import type { HarnessState } from "@/store/harness-types";
import type { AgentConfig } from "@carmel-agent/shared";

type SetState = StoreApi<HarnessState>["setState"];
type GetState = StoreApi<HarnessState>["getState"];
type ResourceActions = Pick<HarnessState,
  "upsertUser" | "upsertAgent" | "createAgent" | "deleteAgent" | "upsertProviderConfig" |
  "deleteProviderConfig" | "upsertModelRef" | "deleteModelRef" | "addPromptTemplate" | "deletePromptTemplate"
>;

export function createResourceSlice(set: SetState, get: GetState): ResourceActions {
  return {
    upsertUser: async (user) => {
      const saved = await api.upsertUser(user.id, { name: user.name, fastTaskModelRefId: user.fastTaskModelRefId });
      set((state) => ({ users: upsertById(state.users, saved) }));
    },
    upsertAgent: async (agent) => {
      const saved = await api.upsertAgent(agent.id, toAgentCommand(agent));
      set((state) => ({ agents: upsertById(state.agents, saved) }));
    },
    createAgent: async (draft) => {
      const timestamp = Date.now();
      const defaultModelRefId = draft?.defaultModelRefId ?? get().modelRefs[0]?.id;
      if (!defaultModelRefId) throw new Error("Create a model before creating an agent.");
      const defaultModelRef = get().modelRefs.find((model) => model.id === defaultModelRefId);
      const agent: AgentConfig = {
        id: createClientId("agent"),
        ownerUserId: draft?.ownerUserId ?? get().activeUserId,
        shared: draft?.shared ?? false,
        name: draft?.name ?? "New agent",
        description: draft?.description ?? "Personal agent",
        workingDirMode: draft?.workingDirMode ?? "default",
        // New agents start with no extensions; an admin arms them afterwards.
        enabledExtensions: [],
        workingDir: draft?.workingDir ?? "",
        defaultWorkingDir: draft?.defaultWorkingDir,
        mounts: draft?.mounts ?? [],
        systemPrompt: draft?.systemPrompt ?? "You are a helpful agent.",
        promptTemplates: draft?.promptTemplates ?? [],
        permissions: draft?.permissions ?? { read: true, write: true, edit: true, bash: false, network: false },
        defaultModelRefId,
        defaultThinkingLevel: defaultModelRef
          ? clampThinkingLevel(resolveModelRef(defaultModelRef), draft?.defaultThinkingLevel ?? "off")
          : "off",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const saved = await api.upsertAgent(agent.id, toAgentCommand(agent));
      set((state) => ({ agents: [...state.agents, saved], activeAgentId: saved.id, activeSessionId: "" }));
      return saved;
    },
    deleteAgent: async (agentId) => {
      await api.deleteAgent(agentId);
      set((state) => {
        const agents = state.agents.filter((item) => item.id !== agentId);
        const sessions = state.sessions.filter((item) => item.agentId !== agentId);
        const deletedSessionIds = new Set(state.sessions.filter((item) => item.agentId === agentId).map((item) => item.id));
        const sessionDetails = Object.fromEntries(Object.entries(state.sessionDetails).filter(([id]) => !deletedSessionIds.has(id)));
        const activeAgentId = state.activeAgentId === agentId ? (agents[0]?.id ?? "") : state.activeAgentId;
        const activeSession = sessions.find(
          (item) => item.agentId === activeAgentId && item.userId === state.activeUserId && isListedSession(item),
        );
        return { agents, sessions, sessionDetails, activeAgentId, activeSessionId: state.activeAgentId === agentId ? (activeSession?.id ?? "") : state.activeSessionId };
      });
    },
    upsertProviderConfig: async (providerConfig) => {
      const saved = await api.upsertProviderConfig(providerConfig.id, toProviderConfigCommand(providerConfig));
      set((state) => ({ providerConfigs: upsertById(state.providerConfigs, saved) }));
    },
    deleteProviderConfig: async (id) => {
      const payload = await api.deleteProviderConfig(id);
      set((state) => resolveBootstrapState(payload, state));
    },
    upsertModelRef: async (model) => {
      const saved = await api.upsertModelRef(model.id, toModelRefCommand(model));
      set((state) => ({ modelRefs: upsertById(state.modelRefs, saved) }));
      return saved;
    },
    deleteModelRef: async (id) => {
      const payload = await api.deleteModelRef(id);
      set((state) => resolveBootstrapState(payload, state));
    },
    addPromptTemplate: async (agentId, template) => {
      const agent = get().agents.find((item) => item.id === agentId);
      if (agent) await get().upsertAgent({ ...agent, promptTemplates: [...agent.promptTemplates, { ...template, id: createClientId("template") }] });
    },
    deletePromptTemplate: async (agentId, templateId) => {
      const agent = get().agents.find((item) => item.id === agentId);
      if (agent) await get().upsertAgent({ ...agent, promptTemplates: agent.promptTemplates.filter((template) => template.id !== templateId) });
    },
  };
}
