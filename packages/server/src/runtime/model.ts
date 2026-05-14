import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel, type Api, type Model } from "@earendil-works/pi-ai";
import { providerConfigs } from "../db/schema";
import type { ModelRef } from "@carmel-agent/shared";

type ProviderConfigRecord = typeof providerConfigs.$inferSelect;

export function resolveServerModelRef(modelRef: ModelRef, providerConfig?: ProviderConfigRecord): Model<Api> {
  const builtIn = getModel(modelRef.provider as never, modelRef.modelId as never);
  const headers = parseHeaders(providerConfig?.customHeaders ?? modelRef.customHeaders);
  if (builtIn) {
    return {
      ...builtIn,
      baseUrl: providerConfig?.baseUrl ?? modelRef.baseUrl ?? builtIn.baseUrl,
      headers,
    };
  }
  return {
    id: modelRef.modelId,
    name: modelRef.label,
    api: modelRef.api ?? "openai-completions",
    provider: modelRef.provider,
    baseUrl: providerConfig?.baseUrl ?? modelRef.baseUrl ?? "",
    reasoning: modelRef.reasoning ?? false,
    input: modelRef.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelRef.contextWindow ?? 128000,
    maxTokens: modelRef.maxTokens ?? 8192,
    headers,
  } as Model<Api>;
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

function parseHeaders(value?: string) {
  if (!value?.trim()) return undefined;
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return undefined;
  }
}
