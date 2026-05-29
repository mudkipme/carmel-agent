import { getModel, getModels, getProviders, type Api, type Model } from "@earendil-works/pi-ai";
import { createClientId } from "@/lib/id";
import {
  DEFAULT_OLLAMA_BASE_URL,
  OLLAMA_PROVIDER,
  type ModelRef,
  type ProviderModelSummary,
} from "@carmel-agent/shared";

const id = createClientId;

export function resolveModelRef(modelRef: ModelRef): Model<Api> {
  const builtIn = getModel(modelRef.provider as never, modelRef.modelId as never);
  if (builtIn) {
    return {
      ...builtIn,
    };
  }
  return {
    id: modelRef.modelId,
    name: modelRef.label,
    api: modelRef.api ?? "openai-completions",
    provider: modelRef.provider,
    baseUrl: modelRef.provider === OLLAMA_PROVIDER ? DEFAULT_OLLAMA_BASE_URL : "",
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
  providerConfigId?: string,
  modelSummary?: ProviderModelSummary,
): ModelRef {
  const model = getModel(provider as never, modelId as never);
  return {
    id: id("model"),
    ownerUserId: "",
    shared: false,
    label: modelSummary?.name ?? model?.name ?? modelId,
    provider,
    providerConfigId,
    modelId,
    api: modelSummary?.api ?? model?.api ?? (provider === OLLAMA_PROVIDER ? "openai-completions" : undefined),
    baseUrl: provider === OLLAMA_PROVIDER ? DEFAULT_OLLAMA_BASE_URL : model?.baseUrl,
    contextWindow: modelSummary?.contextWindow ?? model?.contextWindow,
    maxTokens: modelSummary?.maxTokens ?? model?.maxTokens,
    reasoning: modelSummary?.reasoning ?? model?.reasoning,
    input: modelSummary?.input ?? model?.input,
  };
}

export function modelsForProvider(provider: string) {
  if (provider === OLLAMA_PROVIDER) return [];
  return getModels(provider as never);
}

export function getAppProviders() {
  return Array.from(new Set([...getProviders(), OLLAMA_PROVIDER]));
}

export function defaultBaseUrlForProvider(provider: string) {
  return provider === OLLAMA_PROVIDER ? DEFAULT_OLLAMA_BASE_URL : "";
}
