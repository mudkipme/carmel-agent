import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody } from "../openapi/routes.ts";
import {
  BootstrapPayloadSchema,
  OAuthFlowSchema,
  OAuthProviderSchema,
  ProviderConfigSchema,
  ProviderModelSchema,
  ProviderRequestSchema,
} from "../openapi/schemas.ts";
import {
  DEFAULT_OLLAMA_BASE_URL,
  oauthInputRequestSchema,
  OLLAMA_PROVIDER,
} from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { requireAdmin, type AuthVariables } from "../auth.ts";
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
  readAffectedModelUserIds,
  readFallbackModelForUser,
  reassignModelReferences,
} from "../services/agent-access.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import { listOllamaModels } from "../services/provider-auth.ts";
import { readProviderModels } from "../services/model-catalog.ts";
import { readActiveRunLeaseForProviderConfig } from "../services/active-run-lease.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";
import { errorMessage } from "../errors.ts";

export function createProviderConfigRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.openapi(
    createRoute({
      method: "put",
      path: "/provider-configs/{id}",
      operationId: "upsertProviderConfig",
      tags: ["Providers"],
      middleware: [requireAdmin] as const,
      request: { params: z.object({ id: z.string() }), body: jsonBody(ProviderRequestSchema) },
      responses: { 200: json(ProviderConfigSchema, "Provider"), 409: error },
    }),
    async (c) => {
      const currentUserId = c.get("user").id;
      const providerConfig = c.req.valid("json");
      const timestamp = now();
      const current = db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.id, c.req.param("id")))
        .get();
      const activeRun = current ? readActiveRunLeaseForProviderConfig(current.id) : undefined;
      if (activeRun) return activeRunConflictResponse(c, activeRun);

      const authType = providerConfig.authType ?? current?.authType ?? "api_key";
      const apiKey =
        authType === "api_key"
          ? protectSecret(providerConfig.apiKey ?? current?.apiKey ?? null)
          : null;
      const oauthCredential =
        authType === "oauth" ? protectJsonSecret(current?.oauthCredential ?? null) : null;
      db.insert(providerConfigs)
        .values({
          ...providerConfig,
          id: c.req.param("id"),
          userId: currentUserId,
          authType,
          apiKey,
          oauthCredential,
          createdAt: current?.createdAt ?? timestamp,
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
            updatedAt: timestamp,
          },
        })
        .run();
      return c.json(
        serializeProviderConfig(
          db
            .select()
            .from(providerConfigs)
            .where(eq(providerConfigs.id, c.req.param("id")))
            .get()!,
        ),
        200,
      );
    },
  );

  // Any signed-in user may add model entries, so listing a provider's models
  // is not admin-only. This response contains no credentials.
  route.openapi(
    createRoute({
      method: "get",
      path: "/provider-configs/{id}/models",
      operationId: "listProviderModels",
      tags: ["Providers"],
      parameters: [{ name: "refresh", in: "query", schema: { type: "boolean" } }],
      request: { params: z.object({ id: z.string() }) },
      responses: { 404: error, 502: error, 200: json(z.array(ProviderModelSchema), "Models") },
    }),
    async (c) => {
      const providerConfig = db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.id, c.req.param("id")))
        .get();
      if (!providerConfig) {
        return c.json({ error: "Provider config not found." }, 404);
      }
      if (providerConfig.provider !== OLLAMA_PROVIDER) {
        const refresh = c.req.query("refresh") === "true";
        return c.json(
          await readProviderModels(
            providerConfig,
            refresh ? { allowNetwork: true, force: true } : {},
          ),
          200,
        );
      }

      try {
        return c.json(
          await listOllamaModels(providerConfig.baseUrl ?? DEFAULT_OLLAMA_BASE_URL),
          200,
        );
      } catch (error) {
        return c.json({ error: errorMessage(error, "Unable to discover provider models.") }, 502);
      }
    },
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/oauth/providers",
      operationId: "listOAuthProviders",
      tags: ["Providers"],
      responses: { 200: json(z.array(OAuthProviderSchema), "OAuth providers") },
    }),
    (c) => {
      return c.json(listOAuthProviders(), 200);
    },
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/provider-configs/{id}/oauth/login",
      operationId: "startProviderOAuth",
      tags: ["Providers"],
      middleware: [requireAdmin] as const,
      request: { params: z.object({ id: z.string() }) },
      responses: { 400: error, 404: error, 200: json(OAuthFlowSchema, "OAuth flow") },
    }),
    async (c) => {
      const currentUserId = c.get("user").id;
      const providerConfig = db
        .select()
        .from(providerConfigs)
        .where(eq(providerConfigs.id, c.req.param("id")))
        .get();
      if (!providerConfig) {
        return c.json({ error: "Provider config not found." }, 404);
      }
      try {
        return c.json(await startOAuthLoginFlow(currentUserId, providerConfig), 200);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    },
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/oauth/flows/{id}",
      operationId: "getOAuthFlow",
      tags: ["Providers"],
      middleware: [requireAdmin] as const,
      request: { params: z.object({ id: z.string() }) },
      responses: { 404: error, 200: json(OAuthFlowSchema, "OAuth flow") },
    }),
    (c) => {
      const flow = readOAuthLoginFlow(c.get("user").id, c.req.param("id"));
      if (!flow) return c.json({ error: "OAuth flow not found." }, 404);
      return c.json(flow, 200);
    },
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/oauth/flows/{id}/input",
      operationId: "submitOAuthInput",
      tags: ["Providers"],
      middleware: [requireAdmin] as const,
      request: { params: z.object({ id: z.string() }), body: jsonBody(oauthInputRequestSchema) },
      responses: { 400: error, 404: error, 200: json(OAuthFlowSchema, "OAuth flow") },
    }),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const flow = submitOAuthLoginFlowInput(
          c.get("user").id,
          c.req.param("id"),
          body.value ?? "",
        );
        if (!flow) return c.json({ error: "OAuth flow not found." }, 404);
        return c.json(flow, 200);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 400);
      }
    },
  );

  route.openapi(
    createRoute({
      method: "delete",
      path: "/provider-configs/{id}",
      operationId: "deleteProviderConfig",
      tags: ["Providers"],
      middleware: [requireAdmin] as const,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        404: error,
        200: json(BootstrapPayloadSchema, "Replacement bootstrap"),
        409: error,
      },
    }),
    async (c) => {
      const currentUserId = c.get("user").id;
      const providerConfigId = c.req.param("id");
      if (
        !db
          .select({ id: providerConfigs.id })
          .from(providerConfigs)
          .where(eq(providerConfigs.id, providerConfigId))
          .get()
      ) {
        return c.json({ error: "Provider config not found." }, 404);
      }
      const activeRun = readActiveRunLeaseForProviderConfig(providerConfigId);
      if (activeRun) return activeRunConflictResponse(c, activeRun);
      const relatedModels = db
        .select()
        .from(modelRefs)
        .where(eq(modelRefs.providerConfigId, providerConfigId))
        .all();
      const deletedModelIds = new Set(relatedModels.map((model) => model.id));
      if (deletedModelIds.size > 0) {
        const missingFallbackUserIds = readAffectedModelUserIds(deletedModelIds).filter(
          (userId) => !readFallbackModelForUser(userId, deletedModelIds),
        );
        if (missingFallbackUserIds.length > 0) {
          return c.json(
            {
              error:
                "Every affected user needs another visible model before deleting this provider.",
            },
            409,
          );
        }
      }

      // Reassign references then delete the provider's models and the provider
      // itself atomically, so a failure can't leave dangling references.
      db.transaction(() => {
        if (deletedModelIds.size > 0) reassignModelReferences(deletedModelIds);
        db.delete(modelRefs).where(eq(modelRefs.providerConfigId, providerConfigId)).run();
        db.delete(providerConfigs).where(eq(providerConfigs.id, providerConfigId)).run();
      });
      return c.json(readBootstrapPayload(currentUserId), 200);
    },
  );

  return route;
}
