import { createClientId } from "@/lib/id";
import {
  DEFAULT_OLLAMA_BASE_URL,
  OLLAMA_PROVIDER,
  type ModelRef,
  type ProviderModelSummary,
} from "@carmel-agent/shared";

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
    thinkingLevelMap: modelSummary.thinkingLevelMap,
  };
}
