import type { AgentConfig, ModelRef, ProviderConfig, Session, User } from "@carmel-agent/shared";
import { agents, modelRefs, providerConfigs, sessions, users } from "./db/schema.ts";
import { defaultAgentWorkingDir } from "./paths.ts";

export function serializeUser(user: typeof users.$inferSelect): User {
  return {
    id: user.id,
    username: user.username ?? undefined,
    name: user.name,
    email: user.email,
  };
}

export function serializePublicAgent(agent: typeof agents.$inferSelect): AgentConfig {
  const settings = serializeAgentSettings(agent);
  return {
    ...settings,
    systemPrompt: "",
    promptTemplates: [],
  };
}

export function serializeAgentSettings(agent: typeof agents.$inferSelect): AgentConfig {
  return {
    ...agent,
    workingDirMode: agent.workingDirMode ?? "manual",
    defaultWorkingDir: agent.defaultWorkingDir ?? defaultAgentWorkingDir(agent.id),
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
    authType: providerConfig.authType ?? "api_key",
    apiKey: undefined,
    hasApiKey: Boolean(providerConfig.apiKey),
    hasOAuth: Boolean(providerConfig.oauthCredential),
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
