import { Hono } from "hono";
import { z } from "zod";
import {
  knowledgeReadSchema,
  knowledgeSearchSchema,
  knowledgeSettingsSchema,
  knowledgeSourceInputSchema,
  memoryInputSchema,
} from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { jsonValidator } from "../validation.ts";
import {
  KnowledgeError,
  knowledgeOverview,
  saveKnowledgeSettings,
  addKnowledgeSource,
  deleteKnowledgeSource,
  searchKnowledge,
  readKnowledge,
  refreshKnowledge,
  saveMemory,
  forgetMemory,
} from "../services/knowledge.ts";

export function createKnowledgeRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof KnowledgeError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  route.get("/agents/:agentId/knowledge", async (c) =>
    c.json(await knowledgeOverview(c.get("user").id, c.req.param("agentId"))),
  );
  route.put(
    "/agents/:agentId/knowledge/settings",
    jsonValidator(knowledgeSettingsSchema),
    async (c) =>
      c.json(
        await saveKnowledgeSettings(c.get("user").id, c.req.param("agentId"), c.req.valid("json")),
      ),
  );
  route.post(
    "/agents/:agentId/knowledge/sources",
    jsonValidator(knowledgeSourceInputSchema),
    async (c) =>
      c.json(
        await addKnowledgeSource(c.get("user").id, c.req.param("agentId"), c.req.valid("json")),
        201,
      ),
  );
  route.delete("/agents/:agentId/knowledge/sources/:sourceId", async (c) => {
    await deleteKnowledgeSource(c.get("user").id, c.req.param("agentId"), c.req.param("sourceId"));
    return c.json({ ok: true });
  });
  route.post("/agents/:agentId/knowledge/search", jsonValidator(knowledgeSearchSchema), async (c) =>
    c.json(
      await searchKnowledge(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.valid("json"),
        c.req.raw.signal,
      ),
    ),
  );
  route.post("/agents/:agentId/knowledge/read", jsonValidator(knowledgeReadSchema), async (c) =>
    c.json(await readKnowledge(c.get("user").id, c.req.param("agentId"), c.req.valid("json"))),
  );
  route.post(
    "/agents/:agentId/knowledge/refresh",
    jsonValidator(
      z.object({
        embed: z.boolean().default(false),
        allowDownloads: z.boolean().default(false),
        deep: z.boolean().default(false),
      }),
    ),
    async (c) => {
      const { embed, allowDownloads, deep } = c.req.valid("json");
      await refreshKnowledge(c.get("user").id, c.req.param("agentId"), embed, allowDownloads, deep);
      return c.json({ ok: true }, 202);
    },
  );
  route.post("/agents/:agentId/knowledge/memories", jsonValidator(memoryInputSchema), async (c) =>
    c.json(await saveMemory(c.get("user").id, c.req.param("agentId"), c.req.valid("json")), 201),
  );
  route.put(
    "/agents/:agentId/knowledge/memories/:memoryId",
    jsonValidator(memoryInputSchema),
    async (c) =>
      c.json(
        await saveMemory(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.valid("json"),
          c.req.param("memoryId"),
        ),
      ),
  );
  route.delete(
    "/agents/:agentId/knowledge/memories/:memoryId",
    jsonValidator(z.object({ expectedRevision: z.string().min(1) })),
    async (c) => {
      await forgetMemory(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("memoryId"),
        c.req.valid("json").expectedRevision,
      );
      return c.json({ ok: true });
    },
  );
  return route;
}
