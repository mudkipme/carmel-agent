import type { Api, Model } from "@earendil-works/pi-ai";
import { createClientId } from "@/lib/id";
import {
  DEFAULT_OLLAMA_BASE_URL,
  OLLAMA_PROVIDER,
  type ModelCatalog,
  type ModelRef,
  type ProviderModelSummary,
} from "@carmel-agent/shared";

export function resolveModelRef(modelRef: ModelRef): Model<Api> {
  return {
    id: modelRef.modelId,
    name: modelRef.label,
    api: modelRef.api ?? "openai-completions",
    provider: modelRef.provider,
    baseUrl: modelRef.baseUrl ?? defaultBaseUrlForProvider(modelRef.provider),
    reasoning: modelRef.reasoning ?? false,
    input: modelRef.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelRef.contextWindow ?? 128000,
    maxTokens: modelRef.maxTokens ?? 8192,
  } as Model<Api>;
}

export function makeModelRef(
  provider: string,
  modelId: string,
  providerConfigId: string | undefined,
  modelSummary: ProviderModelSummary,
): ModelRef {
  return {
    id: createClientId("model"),
    ownerUserId: "",
    shared: false,
    label: modelSummary.name || modelId,
    provider,
    providerConfigId,
    modelId,
    api: modelSummary.api ?? (provider === OLLAMA_PROVIDER ? "openai-completions" : undefined),
    baseUrl: provider === OLLAMA_PROVIDER ? DEFAULT_OLLAMA_BASE_URL : undefined,
    contextWindow: modelSummary.contextWindow,
    maxTokens: modelSummary.maxTokens,
    reasoning: modelSummary.reasoning,
    input: modelSummary.input,
  };
}

export function getAppProviders(catalog: ModelCatalog) {
  return catalog.providers.map((provider) => provider.id);
}

export function defaultBaseUrlForProvider(provider: string) {
  return provider === OLLAMA_PROVIDER ? DEFAULT_OLLAMA_BASE_URL : "";
}
