import type { AgentConfig, ModelRef, ProviderConfig, Session } from "@carmel-agent/shared";
import { agents, modelRefs, providerConfigs, sessions } from "./db/schema";

export function serializePublicAgent(agent: typeof agents.$inferSelect): AgentConfig {
  return {
    ...agent,
    systemPrompt: "",
    promptTemplates: [],
  };
}

export function serializeModelRef(model: typeof modelRefs.$inferSelect): ModelRef {
  return {
    ...model,
    providerConfigId: model.providerConfigId ?? undefined,
    api: model.api ?? undefined,
    baseUrl: model.baseUrl ?? undefined,
    contextWindow: model.contextWindow ?? undefined,
    maxTokens: model.maxTokens ?? undefined,
    customHeaders: undefined,
  };
}

export function serializeProviderConfig(providerConfig: typeof providerConfigs.$inferSelect): ProviderConfig {
  return {
    ...providerConfig,
    apiKey: undefined,
    hasApiKey: Boolean(providerConfig.apiKey),
    baseUrl: providerConfig.baseUrl ?? undefined,
    customHeaders: undefined,
  };
}

export function serializeSession(session: Session | typeof sessions.$inferSelect): Session {
  return {
    ...session,
    forkedFrom: session.forkedFrom ?? undefined,
  };
}
