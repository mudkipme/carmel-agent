import { getModel, getModels, getProviders } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentPermissions, ModelRef, ProviderConfig, Session, User } from "@carmel-agent/shared";

export const now = () => Date.now();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export const defaultPermissions: AgentPermissions = {
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
};

const provider = getProviders()[0] ?? "anthropic";
const providerModels = getModels(provider as never);
const model = providerModels[0] ?? getModel("anthropic" as never, "claude-sonnet-4-20250514" as never);

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
  skills: [],
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

export const defaultSession: Session = {
  id: "session_initial",
  title: "Initial session",
  userId: defaultUser.id,
  agentId: defaultAgent.id,
  modelRefId: defaultModelRef.id,
  thinkingLevel: "off",
  messages: [],
  createdAt: now(),
  updatedAt: now(),
};
