import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { providerConfigs } from "../db/schema.ts";
import type { ModelRef } from "@carmel-agent/shared";
import { resolveServerModelDefinition } from "../services/model-catalog.ts";

type ProviderConfigRecord = typeof providerConfigs.$inferSelect;

export function resolveServerModelRef(modelRef: ModelRef, providerConfig?: ProviderConfigRecord): Model<Api> {
  return resolveServerModelDefinition(modelRef, { baseUrl: providerConfig?.baseUrl ?? modelRef.baseUrl });
}

export function createAgentError(error: unknown, model: Model<Api>) {
  const message: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  return { type: "agent_end", messages: [message] };
}
