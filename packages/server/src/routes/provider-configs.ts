import { DEFAULT_OLLAMA_BASE_URL, OLLAMA_PROVIDER, type ProviderConfig, type ProviderModelSummary } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { modelRefs, providerConfigs } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import {
  listOAuthProviders,
  readOAuthLoginFlow,
  startOAuthLoginFlow,
  submitOAuthLoginFlowInput,
} from "../runtime/oauth-flows.ts";
import { serializeProviderConfig } from "../serializers.ts";
import { protectJsonSecret, protectSecret } from "../security.ts";
import {
  ownsProviderConfig,
  readAffectedModelUserIds,
  readFallbackModelForUser,
  reassignModelReferences,
} from "../services/agent-access.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { listOllamaModels } from "../services/provider-auth.ts";
import { jsonValidator, oauthInputRequestSchema, providerConfigRequestSchema } from "../validation.ts";

export function createProviderConfigRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.put("/provider-configs/:id", jsonValidator(providerConfigRequestSchema), async (c) => {
    const currentUserId = c.get("user").id;
    const providerConfig = c.req.valid("json") as ProviderConfig;
    const timestamp = now();
    const current = db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get();
    if (current && current.userId !== currentUserId) return c.json({ error: "Provider config not found." }, 404);

    const authType = providerConfig.authType ?? current?.authType ?? "api_key";
    const apiKey = authType === "api_key" ? protectSecret(providerConfig.apiKey ?? current?.apiKey ?? null) : null;
    const oauthCredential = authType === "oauth" ? protectJsonSecret(current?.oauthCredential ?? null) : null;
    db.insert(providerConfigs)
      .values({
        ...providerConfig,
        id: c.req.param("id"),
        userId: currentUserId,
        authType,
        apiKey,
        oauthCredential,
        customHeaders: protectSecret(providerConfig.customHeaders),
        createdAt: providerConfig.createdAt ?? timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: providerConfigs.id,
        set: {
          userId: currentUserId,
          label: providerConfig.label,
          provider: providerConfig.provider,
          authType,
          apiKey,
          oauthCredential,
          baseUrl: providerConfig.baseUrl,
          customHeaders: protectSecret(providerConfig.customHeaders),
          updatedAt: timestamp,
        },
      })
      .run();
    return c.json(
      serializeProviderConfig(db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get()!),
    );
  });

  route.get("/provider-configs/:id/models", async (c) => {
    const currentUserId = c.get("user").id;
    const providerConfig = db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get();
    if (!providerConfig || providerConfig.userId !== currentUserId) {
      return c.json({ error: "Provider config not found." }, 404);
    }
    if (providerConfig.provider !== OLLAMA_PROVIDER) return c.json([] satisfies ProviderModelSummary[]);

    try {
      return c.json(await listOllamaModels(providerConfig.baseUrl ?? DEFAULT_OLLAMA_BASE_URL));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to discover provider models." }, 502);
    }
  });

  route.get("/oauth/providers", (c) => {
    return c.json(listOAuthProviders());
  });

  route.post("/provider-configs/:id/oauth/login", async (c) => {
    const currentUserId = c.get("user").id;
    const providerConfig = db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get();
    if (!providerConfig || providerConfig.userId !== currentUserId) {
      return c.json({ error: "Provider config not found." }, 404);
    }
    try {
      return c.json(await startOAuthLoginFlow(currentUserId, providerConfig));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  route.get("/oauth/flows/:id", (c) => {
    const flow = readOAuthLoginFlow(c.get("user").id, c.req.param("id"));
    if (!flow) return c.json({ error: "OAuth flow not found." }, 404);
    return c.json(flow);
  });

  route.post("/oauth/flows/:id/input", jsonValidator(oauthInputRequestSchema), async (c) => {
    const body = c.req.valid("json");
    try {
      const flow = submitOAuthLoginFlowInput(c.get("user").id, c.req.param("id"), body.value ?? "");
      if (!flow) return c.json({ error: "OAuth flow not found." }, 404);
      return c.json(flow);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  route.delete("/provider-configs/:id", (c) => {
    const currentUserId = c.get("user").id;
    const providerConfigId = c.req.param("id");
    if (!ownsProviderConfig(currentUserId, providerConfigId)) {
      return c.json({ error: "Provider config not found." }, 404);
    }
    const relatedModels = db.select().from(modelRefs).where(eq(modelRefs.providerConfigId, providerConfigId)).all();
    const deletedModelIds = new Set(relatedModels.map((model) => model.id));
    if (deletedModelIds.size > 0) {
      const missingFallbackUserIds = readAffectedModelUserIds(deletedModelIds).filter(
        (userId) => !readFallbackModelForUser(userId, deletedModelIds),
      );
      if (missingFallbackUserIds.length > 0) {
        return c.json({ error: "Every affected user needs another visible model before deleting this provider." }, 409);
      }
      reassignModelReferences(deletedModelIds);
    }

    db.delete(modelRefs).where(eq(modelRefs.providerConfigId, providerConfigId)).run();
    db.delete(providerConfigs).where(eq(providerConfigs.id, providerConfigId)).run();
    return c.json(readBootstrapPayload(currentUserId));
  });

  return route;
}
