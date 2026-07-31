import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_OLLAMA_BASE_URL,
  OLLAMA_PROVIDER,
  type ModelCatalog,
  type ModelRef,
  type ProviderModelSummary,
} from "@carmel-agent/shared";

export function readModelCatalog(): ModelCatalog {
  return {
    providers: Array.from(new Set([...getBuiltinProviders(), OLLAMA_PROVIDER])).map((id) => ({ id, name: id })),
  };
}

export function readBuiltinProviderModels(provider: string): ProviderModelSummary[] {
  if (provider === OLLAMA_PROVIDER) return [];
  return getBuiltinModels(provider as never).map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: model.input,
  }));
}

export function resolveServerModelDefinition(modelRef: ModelRef, options?: { baseUrl?: string }): Model<Api> {
  const builtIn = getBuiltinModel(modelRef.provider as never, modelRef.modelId as never);
  const baseUrl = options?.baseUrl ?? modelRef.baseUrl ?? (modelRef.provider === OLLAMA_PROVIDER ? DEFAULT_OLLAMA_BASE_URL : "");
  if (builtIn) return { ...builtIn, baseUrl: baseUrl || builtIn.baseUrl };
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
    compat: modelRef.provider === OLLAMA_PROVIDER ? ollamaCompat : undefined,
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
