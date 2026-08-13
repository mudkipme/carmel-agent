import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

// The single ModelRef -> Pi `Model` mapping. Both the client (thinking-level
// clamping, model pickers) and the server (agent runs, title generation) go
// through `resolveModelRef`, so they can never disagree about what a stored
// model entry actually denotes.

export const OLLAMA_PROVIDER = "ollama";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

/** Fallbacks for model entries the Pi catalog does not know (custom endpoints, Ollama tags). */
export const DEFAULT_MODEL_API: Api = "openai-completions";
export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MODEL_MAX_TOKENS = 8_192;

/** Ollama's OpenAI-compatible endpoint omits several optional request/response fields. */
export const OLLAMA_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens" as const,
  supportsStrictMode: false,
};

export type ModelRef = {
  id: string;
  ownerUserId: string;
  shared: boolean;
  label: string;
  provider: string;
  providerConfigId?: string;
  modelId: string;
  api?: Api;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  /**
   * Per-level provider values. Pi only offers `xhigh`/`max` when this map has an
   * entry for them (`getSupportedThinkingLevels`), so a model that omits it is
   * capped at `high` no matter how capable it is.
   */
  thinkingLevelMap?: ThinkingLevelMap;
};

export type ProviderModelSummary = {
  id: string;
  name: string;
  api?: Api;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  thinkingLevelMap?: ThinkingLevelMap;
};

export type ModelProviderSummary = {
  id: string;
  name: string;
};

export type ModelCatalog = {
  providers: ModelProviderSummary[];
};

export type ResolveModelRefOptions = {
  /**
   * The Pi catalog/builtin entry for this model, when the caller can look one up.
   * Only the server has a `ModelRuntime`; the client relies on the catalog fields
   * the server already backfilled into the serialized `ModelRef`.
   */
  catalogModel?: Model<Api>;
  /** Provider-config base URL, which overrides the one stored on the model entry. */
  baseUrl?: string;
};

export function resolveModelRef(modelRef: ModelRef, options: ResolveModelRefOptions = {}): Model<Api> {
  const baseUrl = options.baseUrl ?? modelRef.baseUrl ?? defaultBaseUrlForProvider(modelRef.provider);
  if (options.catalogModel) {
    return {
      ...options.catalogModel,
      baseUrl: baseUrl || options.catalogModel.baseUrl,
      // The stored entry wins per level, matching how Pi's own model config
      // layers a model override onto a catalog entry.
      thinkingLevelMap: mergeThinkingLevelMaps(options.catalogModel.thinkingLevelMap, modelRef.thinkingLevelMap),
    };
  }
  return {
    id: modelRef.modelId,
    name: modelRef.label,
    api: modelRef.api ?? DEFAULT_MODEL_API,
    provider: modelRef.provider,
    baseUrl,
    reasoning: modelRef.reasoning ?? false,
    input: modelRef.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelRef.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: modelRef.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
    thinkingLevelMap: modelRef.thinkingLevelMap,
    compat: modelRef.provider === OLLAMA_PROVIDER ? OLLAMA_COMPAT : undefined,
  } as Model<Api>;
}

/** Undefined when neither side defines one, so Pi keeps its provider defaults. */
function mergeThinkingLevelMaps(
  catalog: ThinkingLevelMap | undefined,
  override: ThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
  if (!catalog) return override;
  if (!override) return catalog;
  return { ...catalog, ...override };
}

export function defaultBaseUrlForProvider(provider: string) {
  return provider === OLLAMA_PROVIDER ? DEFAULT_OLLAMA_BASE_URL : "";
}
