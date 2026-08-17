import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { providerConfigs } from "../db/schema.ts";
import {
  getOllamaThinkingLevelMap,
  OLLAMA_PROVIDER,
  resolveModelRef,
  type ModelRef,
} from "@carmel-agent/shared";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { getCachedCatalogModel } from "./model-store.ts";
import { errorMessage } from "../errors.ts";

type ProviderConfigRecord = typeof providerConfigs.$inferSelect;

/**
 * Server-side `resolveModelRef`: same shared mapping, plus the Pi catalog lookup
 * and provider-config base URL that only the server can supply.
 */
export function resolveServerModelRef(
  modelRef: ModelRef,
  providerConfig?: ProviderConfigRecord,
  modelRuntime?: Pick<ModelRuntime, "getModel">,
): Model<Api> {
  return resolveModelRef(modelRef, {
    catalogModel:
      modelRuntime?.getModel(modelRef.provider, modelRef.modelId) ??
      // The refreshed provider catalog, which is the only source that knows
      // which thinking levels a model actually accepts. Callers without a
      // ModelRuntime (the serializers) would otherwise see just the bundled
      // catalog, which declares none.
      getCachedCatalogModel(modelRef.provider, modelRef.modelId) ??
      getBuiltinModel(modelRef.provider as never, modelRef.modelId as never),
    baseUrl: providerConfig?.baseUrl ?? undefined,
  });
}

/**
 * Reduce a submitted level map to the entries that actually disagree with the
 * provider catalog. The client echoes back the effective map the serializer gave
 * it, so persisting it verbatim would freeze today's catalog onto the entry and
 * mask later provider changes. Returns null when nothing is overridden.
 */
export function thinkingLevelOverrides(
  modelRef: Pick<ModelRef, "provider" | "modelId" | "thinkingLevelMap">,
): ThinkingLevelMap | null {
  const submitted = modelRef.thinkingLevelMap;
  if (!submitted) return null;
  const catalog =
    getCachedCatalogModel(modelRef.provider, modelRef.modelId)?.thinkingLevelMap ??
    (modelRef.provider === OLLAMA_PROVIDER
      ? getOllamaThinkingLevelMap(modelRef.modelId)
      : {});
  const overrides: ThinkingLevelMap = {};
  for (const [level, value] of Object.entries(submitted) as Array<[ModelThinkingLevel, string | null | undefined]>) {
    if (value === undefined) continue;
    if (catalog[level] !== value) overrides[level] = value;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
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
    errorMessage: errorMessage(error),
    timestamp: Date.now(),
  };
  return { type: "agent_end", messages: [message] };
}
