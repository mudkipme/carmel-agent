import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { modelRefs, providerConfigs, providerKeys } from "../db/schema.ts";
import type { AgentThinkingLevel } from "@carmel-agent/shared";
import { createProviderConfigCredentialStore } from "../runtime/auth-storage.ts";
import { bindResolvedModel, createCarmelModelRuntime } from "../runtime/model-runtime.ts";
import { withProviderAttribution } from "../runtime/provider-attribution.ts";
import { resolveServerModelRef } from "../runtime/model.ts";
import { revealSecret } from "../security.ts";
import { serializeModelRef } from "../serializers.ts";
import { readUsableModelRef, resolveSupportedThinkingLevel } from "./agent-access.ts";
import { ensureOptionalProviderAuth, hasProviderAuth } from "./provider-auth.ts";

type ModelRefRecord = typeof modelRefs.$inferSelect;

export type ResolvedModelContext = {
  modelRef: ModelRefRecord;
  providerConfig?: typeof providerConfigs.$inferSelect;
  modelRuntime: Awaited<ReturnType<typeof createCarmelModelRuntime>>;
  model: ReturnType<typeof resolveServerModelRef>;
};

export type ModelContextResult =
  | { ok: true; value: ResolvedModelContext }
  | { ok: false; reason: "not_found" | "no_auth" };

export const NO_PROVIDER_AUTH_MESSAGE =
  "No API key or OAuth login configured for this model provider.";

export async function resolveModelContext(
  userId: string,
  modelRefId: string,
): Promise<ModelContextResult> {
  const modelRef = readUsableModelRef(userId, modelRefId);
  if (!modelRef) {
    return { ok: false, reason: "not_found" };
  }
  const providerConfig = modelRef.providerConfigId
    ? db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.id, modelRef.providerConfigId))
        .get()
    : undefined;
  const modelRuntime = await createCarmelModelRuntime(
    providerConfig
      ? createProviderConfigCredentialStore(providerConfig, modelRef.provider)
      : undefined,
  );
  if (!providerConfig) {
    const providerKey = db
      .select()
      .from(providerKeys)
      .where(eq(providerKeys.userId, userId))
      .all()
      .find((item) => item.provider === modelRef.provider);
    if (providerKey?.apiKey) {
      await modelRuntime.setRuntimeApiKey(
        modelRef.provider,
        revealSecret(providerKey.apiKey) ?? "",
      );
    }
  }
  await ensureOptionalProviderAuth(
    modelRuntime,
    modelRef.provider,
    providerConfig?.baseUrl ?? modelRef.baseUrl ?? undefined,
  );
  if (!(await hasProviderAuth(modelRuntime, modelRef.provider))) {
    return { ok: false, reason: "no_auth" };
  }
  const model = resolveServerModelRef(serializeModelRef(modelRef), providerConfig, modelRuntime);
  return {
    ok: true,
    value: {
      modelRef,
      providerConfig,
      // Bound, not raw: Pi resolves the generation model out of this runtime, so
      // the runtime -- not the `model` beside it -- is what decides where the
      // request goes. They are returned together so they cannot disagree.
      //
      // Attribution wraps the bound runtime because it reads the model Pi
      // actually resolved, base URL included, which is what decides whether a
      // request is going to OpenRouter at all.
      modelRuntime: withProviderAttribution(bindResolvedModel(modelRuntime, model)),
      model,
    },
  };
}

export type RunModelResult =
  | { ok: true; value: ResolvedModelContext & { thinkingLevel: AgentThinkingLevel } }
  | { ok: false; reason: "not_found" | "no_auth" };

/**
 * Everything a run needs from its model: the resolved context, and the
 * requested thinking level clamped to what that model supports.
 */
export async function resolveRunModel(
  userId: string,
  modelRefId: string,
  thinkingLevel: AgentThinkingLevel,
): Promise<RunModelResult> {
  const context = await resolveModelContext(userId, modelRefId);
  if (!context.ok) return context;
  return {
    ok: true,
    value: {
      ...context.value,
      thinkingLevel: resolveSupportedThinkingLevel(context.value.modelRef, thinkingLevel),
    },
  };
}
