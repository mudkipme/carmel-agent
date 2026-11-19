import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody } from "../openapi/routes.ts";
import {
  KnowledgeDocumentSchema,
  KnowledgeOverviewSchema,
  KnowledgeReadRequestSchema,
  KnowledgeSearchRequestSchema,
  KnowledgeSearchResultSchema,
  KnowledgeSettingsSchema,
  KnowledgeSourceSchema,
  KnowledgeSourceRequestSchema,
  OKSchema,
} from "../openapi/schemas.ts";
import { indexRefreshSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import {
  KnowledgeError,
  knowledgeOverview,
  readKnowledgeSettings,
  saveKnowledgeSettings,
  addKnowledgeSource,
  deleteKnowledgeSource,
  searchKnowledge,
  readKnowledge,
  refreshKnowledge,
} from "./service.ts";

export function createKnowledgeRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof KnowledgeError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/knowledge",
      operationId: "getKnowledge",
      tags: ["Knowledge"],
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(KnowledgeOverviewSchema, "getKnowledge"),
        400: error,
        403: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) => c.json(await knowledgeOverview(c.get("user").id, c.req.param("agentId")), 200),
  );
  route.openapi(
    createRoute({
      method: "put",
      path: "/agents/{agentId}/knowledge/settings",
      operationId: "saveKnowledgeSettings",
      tags: ["Knowledge"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(KnowledgeSettingsSchema),
      },
      responses: {
        200: json(KnowledgeSettingsSchema, "saveKnowledgeSettings"),
        400: error,
        403: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) =>
      c.json(
        await saveKnowledgeSettings(c.get("user").id, c.req.param("agentId"), c.req.valid("json")),
        200,
      ),
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/knowledge/settings",
      operationId: "getKnowledgeSettings",
      tags: ["Knowledge"],
      summary: "Read the agent's knowledge settings",
      description:
        "Available to users who can access the agent when its read permission is enabled. Returns settings without scanning documents or starting a knowledge worker.",
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(
          KnowledgeSettingsSchema,
          "Current knowledge settings, including defaults when not configured.",
        ),
        403: error,
        404: error,
      },
    }),
    (c) => c.json(readKnowledgeSettings(c.get("user").id, c.req.param("agentId")), 200),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/knowledge/sources",
      operationId: "addKnowledgeSource",
      tags: ["Knowledge"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(KnowledgeSourceRequestSchema),
      },
      responses: {
        201: json(KnowledgeSourceSchema, "addKnowledgeSource"),
        400: error,
        403: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) =>
      c.json(
        await addKnowledgeSource(c.get("user").id, c.req.param("agentId"), c.req.valid("json")),
        201,
      ),
  );
  route.openapi(
    createRoute({
      method: "delete",
      path: "/agents/{agentId}/knowledge/sources/{sourceId}",
      operationId: "disconnectKnowledgeSource",
      tags: ["Knowledge"],
      request: { params: z.object({ agentId: z.string(), sourceId: z.string() }) },
      responses: {
        200: json(OKSchema, "disconnectKnowledgeSource"),
        400: error,
        403: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) => {
      await deleteKnowledgeSource(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("sourceId"),
      );
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/knowledge/search",
      operationId: "searchKnowledge",
      tags: ["Knowledge"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(KnowledgeSearchRequestSchema),
      },
      responses: {
        200: json(KnowledgeSearchResultSchema, "searchKnowledge"),
        400: error,
        403: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) =>
      c.json(
        await searchKnowledge(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.valid("json"),
          c.req.raw.signal,
        ),
        200,
      ),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/knowledge/read",
      operationId: "readKnowledge",
      tags: ["Knowledge"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(KnowledgeReadRequestSchema),
      },
      responses: {
        200: json(KnowledgeDocumentSchema, "readKnowledge"),
        400: error,
        403: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) =>
      c.json(
        await readKnowledge(c.get("user").id, c.req.param("agentId"), c.req.valid("json")),
        200,
      ),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/knowledge/refresh",
      operationId: "refreshKnowledge",
      tags: ["Knowledge"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(indexRefreshSchema.meta({ id: "KnowledgeRefreshRequest" })),
      },
      responses: {
        202: json(OKSchema, "refreshKnowledge"),
        400: error,
        403: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) => {
      const { embed, allowDownloads, deep } = c.req.valid("json");
      await refreshKnowledge(c.get("user").id, c.req.param("agentId"), embed, allowDownloads, deep);
      return c.json({ ok: true }, 202);
    },
  );
  return route;
}
