import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { modelRefs, providerConfigs, providerKeys } from "../db/schema.ts";
import { createProviderConfigCredentialStore } from "../runtime/auth-storage.ts";
import { createCarmelModelRuntime } from "../runtime/model-runtime.ts";
import { resolveServerModelRef } from "../runtime/model.ts";
import { revealSecret } from "../security.ts";
import { serializeModelRef } from "../serializers.ts";
import { canUseModel } from "./agent-access.ts";
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

export async function resolveModelContext(
  userId: string,
  modelRefId: string,
  options?: { canUse?: (userId: string, modelRef: ModelRefRecord) => boolean },
): Promise<ModelContextResult> {
  const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, modelRefId)).get();
  if (!modelRef || !(options?.canUse ?? canUseModel)(userId, modelRef)) {
    return { ok: false, reason: "not_found" };
  }
  const providerConfig = modelRef.providerConfigId
    ? db.select().from(providerConfigs).where(eq(providerConfigs.id, modelRef.providerConfigId)).get()
    : undefined;
  const modelRuntime = await createCarmelModelRuntime(
    providerConfig ? createProviderConfigCredentialStore(providerConfig, modelRef.provider) : undefined,
  );
  if (!providerConfig) {
    const providerKey = db
      .select()
      .from(providerKeys)
      .where(eq(providerKeys.userId, userId))
      .all()
      .find((item) => item.provider === modelRef.provider);
    if (providerKey?.apiKey) {
      await modelRuntime.setRuntimeApiKey(modelRef.provider, revealSecret(providerKey.apiKey) ?? "");
    }
  }
  await ensureOptionalProviderAuth(modelRuntime, modelRef.provider);
  if (!(await hasProviderAuth(modelRuntime, modelRef.provider))) {
    return { ok: false, reason: "no_auth" };
  }
  return {
    ok: true,
    value: {
      modelRef,
      providerConfig,
      modelRuntime,
      model: resolveServerModelRef(serializeModelRef(modelRef), providerConfig),
    },
  };
}
