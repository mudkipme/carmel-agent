import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { providerConfigs } from "../db/schema.ts";
import { resolveModelRef, type ModelRef } from "@carmel-agent/shared";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
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
      getBuiltinModel(modelRef.provider as never, modelRef.modelId as never),
    baseUrl: providerConfig?.baseUrl ?? undefined,
  });
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
