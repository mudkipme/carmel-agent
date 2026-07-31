import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRef } from "./index.ts";

const OLLAMA_PROVIDER_ID = "ollama";
const OLLAMA_BASE_URL = "http://localhost:11434/v1";

export function resolveModelRef(modelRef: ModelRef, options?: { baseUrl?: string }): Model<Api> {
  const builtIn = getBuiltinModel(modelRef.provider as never, modelRef.modelId as never);
  const baseUrl =
    options?.baseUrl ??
    modelRef.baseUrl ??
    (modelRef.provider === OLLAMA_PROVIDER_ID ? OLLAMA_BASE_URL : "");
  if (builtIn) {
    return {
      ...builtIn,
      baseUrl: baseUrl || builtIn.baseUrl,
    };
  }
  return {
    id: modelRef.modelId,
    name: modelRef.label,
    api: modelRef.api ?? "openai-completions",
    provider: modelRef.provider,
    baseUrl,
    reasoning: modelRef.reasoning ?? false,
    input: modelRef.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelRef.contextWindow ?? 128000,
    maxTokens: modelRef.maxTokens ?? 8192,
    compat: modelRef.provider === OLLAMA_PROVIDER_ID ? ollamaCompat : undefined,
  } as Model<Api>;
}

const ollamaCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens" as const,
  supportsStrictMode: false,
};
