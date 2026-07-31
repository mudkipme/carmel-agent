import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { createClientId } from "@/lib/id";
import {
  DEFAULT_OLLAMA_BASE_URL,
  OLLAMA_PROVIDER,
  type ModelRef,
  type ProviderModelSummary,
  resolveModelRef,
} from "@carmel-agent/shared";

const id = createClientId;

export { resolveModelRef };

export function makeModelRef(
  provider: string,
  modelId: string,
  providerConfigId?: string,
  modelSummary?: ProviderModelSummary,
): ModelRef {
  const model = getBuiltinModel(provider as never, modelId as never);
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
  return getBuiltinModels(provider as never);
}

export function getAppProviders() {
  return Array.from(new Set([...getBuiltinProviders(), OLLAMA_PROVIDER]));
}

export function defaultBaseUrlForProvider(provider: string) {
  return provider === OLLAMA_PROVIDER ? DEFAULT_OLLAMA_BASE_URL : "";
}
