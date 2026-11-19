import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody } from "../openapi/routes.ts";
import { BootstrapPayloadSchema, ModelRefSchema, ModelRequestSchema } from "../openapi/schemas.ts";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { modelRefs, providerConfigs } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { serializeModelRef } from "../serializers.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import {
  readAffectedModelUserIds,
  readFallbackModelForUser,
  reassignModelReferences,
} from "../services/agent-access.ts";
import { thinkingLevelOverrides } from "../runtime/model.ts";
import { readActiveRunLeaseForModels } from "../services/active-run-lease.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";

export function createModelRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.openapi(
    createRoute({
      method: "put",
      path: "/models/{id}",
      operationId: "upsertModel",
      tags: ["Models"],
      request: { params: z.object({ id: z.string() }), body: jsonBody(ModelRequestSchema) },
      responses: { 404: error, 200: json(ModelRefSchema, "Model"), 409: error },
    }),
    async (c) => {
      const currentUserId = c.get("user").id;
      const model = c.req.valid("json");
      const current = db
        .select()
        .from(modelRefs)
        .where(eq(modelRefs.id, c.req.param("id")))
        .get();
      if (current && current.ownerUserId !== currentUserId)
        return c.json({ error: "Model not found." }, 404);
      const activeRun = current ? readActiveRunLeaseForModels([current.id]) : undefined;
      if (activeRun) return activeRunConflictResponse(c, activeRun);
      if (
        model.providerConfigId &&
        !db
          .select({ id: providerConfigs.id })
          .from(providerConfigs)
          .where(eq(providerConfigs.id, model.providerConfigId))
          .get()
      ) {
        return c.json({ error: "Provider config not found." }, 404);
      }
      const timestamp = now();
      const duplicate = db
        .select()
        .from(modelRefs)
        .where(
          and(
            ne(modelRefs.id, c.req.param("id")),
            eq(modelRefs.modelId, model.modelId),
            model.providerConfigId
              ? eq(modelRefs.providerConfigId, model.providerConfigId)
              : and(eq(modelRefs.provider, model.provider), isNull(modelRefs.providerConfigId)),
          ),
        )
        .get();
      if (duplicate) {
        // The uniqueness indexes are global, but another user's private entry is
        // not something this caller may see or silently adopt.
        if (duplicate.ownerUserId === currentUserId || duplicate.shared)
          return c.json(serializeModelRef(duplicate), 200);
        return c.json({ error: "That model is already configured by another user." }, 409);
      }

      db.insert(modelRefs)
        .values({
          ...model,
          id: c.req.param("id"),
          ownerUserId: currentUserId,
          shared: model.shared ?? false,
          input: model.input ?? ["text"],
          thinkingLevelMap: thinkingLevelOverrides(model),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: modelRefs.id,
          set: {
            label: model.label,
            ownerUserId: currentUserId,
            shared: model.shared ?? false,
            provider: model.provider,
            providerConfigId: model.providerConfigId,
            modelId: model.modelId,
            api: model.api,
            baseUrl: model.baseUrl,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            reasoning: model.reasoning ?? false,
            input: model.input ?? ["text"],
            // Explicit null, not undefined: Drizzle omits undefined from SET, which
            // would make clearing a level map silently keep the old one.
            thinkingLevelMap: thinkingLevelOverrides(model),
            updatedAt: timestamp,
          },
        })
        .run();
      return c.json(
        serializeModelRef(
          db
            .select()
            .from(modelRefs)
            .where(eq(modelRefs.id, c.req.param("id")))
            .get()!,
        ),
        200,
      );
    },
  );

  route.openapi(
    createRoute({
      method: "delete",
      path: "/models/{id}",
      operationId: "deleteModel",
      tags: ["Models"],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        404: error,
        200: json(BootstrapPayloadSchema, "Replacement bootstrap"),
        409: error,
      },
    }),
    async (c) => {
      const currentUserId = c.get("user").id;
      const modelId = c.req.param("id");
      const model = db.select().from(modelRefs).where(eq(modelRefs.id, modelId)).get();
      if (!model || model.ownerUserId !== currentUserId)
        return c.json({ error: "Model not found." }, 404);
      const activeRun = readActiveRunLeaseForModels([modelId]);
      if (activeRun) return activeRunConflictResponse(c, activeRun);
      const deletedModelIds = new Set([modelId]);
      const missingFallbackUserIds = readAffectedModelUserIds(deletedModelIds).filter(
        (userId) => !readFallbackModelForUser(userId, deletedModelIds),
      );
      if (missingFallbackUserIds.length > 0) {
        return c.json(
          { error: "Every affected user needs another visible model before deleting this model." },
          409,
        );
      }
      // Reassign references and delete the model atomically so a mid-way failure
      // can't leave some agents/sessions pointing at a model row that's gone (or
      // partially reassigned).
      db.transaction(() => {
        reassignModelReferences(deletedModelIds);
        db.delete(modelRefs).where(eq(modelRefs.id, modelId)).run();
      });
      return c.json(readBootstrapPayload(currentUserId), 200);
    },
  );

  return route;
}
