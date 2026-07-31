import { eq } from "drizzle-orm";
import { Hono } from "hono";
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
import { readActiveRunLeaseForModels } from "../services/active-run-lease.ts";
import { jsonValidator, modelRefRequestSchema } from "../validation.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";

export function createModelRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.put("/models/:id", jsonValidator(modelRefRequestSchema), async (c) => {
    const currentUserId = c.get("user").id;
    const model = c.req.valid("json");
    const current = db.select().from(modelRefs).where(eq(modelRefs.id, c.req.param("id"))).get();
    if (current && current.ownerUserId !== currentUserId) return c.json({ error: "Model not found." }, 404);
    const activeRun = current ? readActiveRunLeaseForModels([current.id]) : undefined;
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    if (
      model.providerConfigId &&
      !db.select({ id: providerConfigs.id }).from(providerConfigs).where(eq(providerConfigs.id, model.providerConfigId)).get()
    ) {
      return c.json({ error: "Provider config not found." }, 404);
    }
    const timestamp = now();
    const duplicate = db
      .select()
      .from(modelRefs)
      .all()
      .find(
        (item) =>
          item.id !== c.req.param("id") &&
          item.modelId === model.modelId &&
          (model.providerConfigId
            ? item.providerConfigId === model.providerConfigId
            : item.provider === model.provider && !item.providerConfigId),
      );
    if (duplicate) return c.json(serializeModelRef(duplicate));

    db.insert(modelRefs)
      .values({
        ...model,
        id: c.req.param("id"),
        ownerUserId: currentUserId,
        shared: model.shared ?? false,
        input: model.input ?? ["text"],
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
          updatedAt: timestamp,
        },
      })
      .run();
    return c.json(serializeModelRef(db.select().from(modelRefs).where(eq(modelRefs.id, c.req.param("id"))).get()!));
  });

  route.delete("/models/:id", async (c) => {
    const currentUserId = c.get("user").id;
    const modelId = c.req.param("id");
    const model = db.select().from(modelRefs).where(eq(modelRefs.id, modelId)).get();
    if (!model || model.ownerUserId !== currentUserId) return c.json({ error: "Model not found." }, 404);
    const activeRun = readActiveRunLeaseForModels([modelId]);
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    const deletedModelIds = new Set([modelId]);
    const missingFallbackUserIds = readAffectedModelUserIds(deletedModelIds).filter(
      (userId) => !readFallbackModelForUser(userId, deletedModelIds),
    );
    if (missingFallbackUserIds.length > 0) {
      return c.json({ error: "Every affected user needs another visible model before deleting this model." }, 409);
    }
    // Reassign references and delete the model atomically so a mid-way failure
    // can't leave some agents/sessions pointing at a model row that's gone (or
    // partially reassigned).
    db.transaction(() => {
      reassignModelReferences(deletedModelIds);
      db.delete(modelRefs).where(eq(modelRefs.id, modelId)).run();
    });
    return c.json(await readBootstrapPayload(currentUserId));
  });

  return route;
}
