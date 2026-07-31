import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AgentConfig, AgentPermissions, ModelRef, ProviderConfig, Session, User } from "@carmel-agent/shared";

export const now = () => Date.now();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

const defaultPermissions: AgentPermissions = {
  read: true,
  write: true,
  edit: true,
  bash: false,
  network: false,
};

export const defaultUser: User = {
  id: "user_self",
  name: "Local User",
  email: "user@local",
  role: "user",
};

const provider = getBuiltinProviders()[0] ?? "anthropic";
const providerModels = getBuiltinModels(provider as never);
const model = providerModels[0] ?? getBuiltinModel("anthropic" as never, "claude-sonnet-4-20250514" as never);

export const defaultModelRef: ModelRef = {
  id: "model_default",
  ownerUserId: defaultUser.id,
  shared: false,
  label: model?.name ?? "Claude Sonnet",
  provider,
  providerConfigId: "provider_default",
  modelId: model?.id ?? "claude-sonnet-4-20250514",
  api: model?.api,
  contextWindow: model?.contextWindow,
  maxTokens: model?.maxTokens,
  reasoning: model?.reasoning,
  input: model?.input ?? ["text"],
};

export const defaultProviderConfig: ProviderConfig = {
  id: "provider_default",
  userId: defaultUser.id,
  label: `${provider} default`,
  provider,
  createdAt: now(),
  updatedAt: now(),
};

export const defaultAgent: AgentConfig = {
  id: "agent_self",
  ownerUserId: defaultUser.id,
  shared: false,
  name: "Local Agent",
  description: "Default local coding and research agent",
  workingDirMode: "default",
  workingDir: "agents/agent_self/workspace",
  defaultWorkingDir: "agents/agent_self/workspace",
  mounts: [],
  systemPrompt:
    "You are Carmel, a pragmatic local agent harness. Work carefully, explain tradeoffs concisely, and preserve user intent.",
  promptTemplates: [
    {
      id: "template_review",
      name: "Review",
      body: "Review this change for behavioral risks, regressions, and missing tests.",
    },
    {
      id: "template_plan",
      name: "Plan",
      body: "Create a concrete implementation plan with risks and verification steps.",
    },
  ],
  permissions: defaultPermissions,
  defaultModelRefId: defaultModelRef.id,
  defaultThinkingLevel: "off",
  createdAt: now(),
  updatedAt: now(),
};

// The seeded session starts with an empty Pi-native tree.
export const defaultSession: Omit<Session, "messages" | "messageEntryIds"> = {
  id: "session_initial",
  title: "Initial session",
  userId: defaultUser.id,
  agentId: defaultAgent.id,
  modelRefId: defaultModelRef.id,
  thinkingLevel: "off",
  revision: 0,
  createdAt: now(),
  updatedAt: now(),
};
