import { createRoute } from "@hono/zod-openapi";
import { createRouter, error, json, jsonBody } from "../openapi/routes.ts";
import {
  HomeMemoryOverviewSchema,
  HomeMemoryRevisionSchema,
  HomeMemorySchema,
  HomeMemorySearchHitSchema,
  HomeMemoryUpkeepSchema,
  KnowledgeSettingsSchema,
  OKSchema,
} from "../openapi/schemas.ts";
import { z } from "zod";
import {
  homeMemoryInputSchema,
  homeMemoryPatchSchema,
  homeMemorySettingsSchema,
  homeMemorySearchSchema,
  homeMemoryTidySchema,
  indexRefreshSchema,
} from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { HomeError } from "../services/agent-homes.ts";
import {
  readHomeMemoryOverview,
  setHomeMemorySettings,
  saveHomeMemory,
  editHomeMemory,
  forgetHomeMemory,
  homeMemoryHistory,
  restoreHomeMemory,
} from "./service.ts";
import { dreamHomeMemories, tidyHomeMemories } from "./upkeep.ts";

import { refreshHomeMemoryIndex, searchHomeMemory } from "./search.ts";

export function createHomeMemoryRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof HomeError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/home/memory",
      operationId: "getHomeMemory",
      tags: ["Agents"],
      parameters: [
        { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 200 } },
        { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
      ],
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 200: json(HomeMemoryOverviewSchema), 400: error, 404: error, 409: error },
    }),
    (c) =>
      c.json(
        readHomeMemoryOverview(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.query("q")?.slice(0, 200) ?? "",
          Math.max(0, Math.min(100000, Number(c.req.query("offset")) || 0)),
        ),
        200,
      ),
  );
  route.openapi(
    createRoute({
      method: "patch",
      path: "/agents/{agentId}/home/memory/settings",
      operationId: "setHomeMemorySettings",
      tags: ["Agents"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(homeMemorySettingsSchema),
      },
      responses: {
        200: json(
          z.object({
            retrieval: KnowledgeSettingsSchema,
            mode: z.enum(["off", "manual", "automatic"]),
          }),
        ),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) => {
      const settings = setHomeMemorySettings(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.valid("json"),
      );
      return c.json({ mode: settings.mode, retrieval: settings.retrieval }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/memory/search",
      operationId: "searchHomeMemory",
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(homeMemorySearchSchema),
      },
      responses: {
        200: json(
          z.object({
            memories: z.array(HomeMemorySearchHitSchema),
            mode: z.enum(["fast", "semantic", "deep"]),
            warning: z.string().optional(),
          }),
          "Private Home search results",
        ),
      },
    }),
    async (c) =>
      c.json(
        await searchHomeMemory(
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
      path: "/agents/{agentId}/home/memory/refresh",
      operationId: "refreshHomeMemoryIndex",
      request: { params: z.object({ agentId: z.string() }), body: jsonBody(indexRefreshSchema) },
      responses: { 202: json(OKSchema, "Private Home index refresh started") },
    }),
    async (c) => {
      await refreshHomeMemoryIndex(c.get("user").id, c.req.param("agentId"), c.req.valid("json"));
      return c.json({ ok: true }, 202);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/memory/tidy",
      operationId: "tidyHomeMemory",
      tags: ["Agents"],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { dream: { type: "boolean" } },
            },
          },
        },
      },
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(HomeMemoryUpkeepSchema, "Private Home memory tidy and upkeep report"),
        400: error,
        404: error,
        409: error,
      },
    }),
    async (c) => {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = homeMemoryTidySchema.safeParse(raw ?? {});
      if (!parsed.success) return c.json({ error: "Invalid tidy options." }, 400);
      const userId = c.get("user").id;
      const agentId = c.req.param("agentId");
      const tidy = await tidyHomeMemories(userId, agentId);
      const dream = parsed.data.dream ? await dreamHomeMemories(userId, agentId) : null;
      return c.json({ tidy, dream }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/memory",
      operationId: "createHomeMemory",
      tags: ["Agents"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(homeMemoryInputSchema.meta({ id: "HomeMemoryInput" })),
      },
      responses: { 201: json(HomeMemorySchema), 400: error, 404: error, 409: error },
    }),
    (c) =>
      c.json(saveHomeMemory(c.get("user").id, c.req.param("agentId"), c.req.valid("json")), 201),
  );
  route.openapi(
    createRoute({
      method: "patch",
      path: "/agents/{agentId}/home/memory/{id}",
      operationId: "editHomeMemory",
      tags: ["Agents"],
      request: {
        params: z.object({ agentId: z.string(), id: z.string() }),
        body: jsonBody(homeMemoryPatchSchema.meta({ id: "HomeMemoryPatch" })),
      },
      responses: { 200: json(HomeMemorySchema), 400: error, 404: error, 409: error },
    }),
    (c) =>
      c.json(
        editHomeMemory(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.param("id"),
          c.req.valid("json"),
        ),
        200,
      ),
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/home/memory/{id}/history",
      operationId: "getHomeMemoryHistory",
      tags: ["Agents"],
      request: { params: z.object({ agentId: z.string(), id: z.string() }) },
      responses: {
        200: json(z.array(HomeMemoryRevisionSchema)),
        400: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      c.json(homeMemoryHistory(c.get("user").id, c.req.param("agentId"), c.req.param("id")), 200),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/memory/{id}/restore",
      operationId: "restoreHomeMemory",
      tags: ["Agents"],
      request: {
        params: z.object({ agentId: z.string(), id: z.string() }),
        body: jsonBody(
          z
            .object({
              revision: z.number().int().positive(),
              expectedRevision: z.number().int().positive(),
            })
            .strict(),
        ),
      },
      responses: { 200: json(HomeMemorySchema), 400: error, 404: error, 409: error },
    }),
    (c) => {
      const value = c.req.valid("json");
      return c.json(
        restoreHomeMemory(
          c.get("user").id,
          c.req.param("agentId"),
          c.req.param("id"),
          value.revision,
          value.expectedRevision,
        ),
        200,
      );
    },
  );
  route.openapi(
    createRoute({
      method: "delete",
      path: "/agents/{agentId}/home/memory/{id}",
      operationId: "forgetHomeMemory",
      tags: ["Agents"],
      parameters: [
        {
          name: "preventLearning",
          in: "query",
          required: false,
          description:
            "Prevent automatic relearning of removed facts. Explicitly saving a fact again clears its restriction.",
          schema: { type: "boolean", default: true },
        },
        { name: "revision", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
      ],
      request: { params: z.object({ agentId: z.string(), id: z.string() }) },
      responses: { 200: json(OKSchema), 400: error, 404: error, 409: error },
    }),
    async (c) => {
      const revision = Number(c.req.query("revision"));
      if (!Number.isSafeInteger(revision) || revision < 1)
        return c.json({ error: "A memory revision is required." }, 400);
      const preventLearning = z
        .enum(["true", "false"])
        .default("true")
        .safeParse(c.req.query("preventLearning"));
      if (!preventLearning.success)
        return c.json({ error: "preventLearning must be true or false." }, 400);
      await forgetHomeMemory(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("id"),
        revision,
        preventLearning.data === "true",
      );
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "delete",
      path: "/agents/{agentId}/home/memory",
      operationId: "clearHomeMemory",
      tags: ["Agents"],
      parameters: [
        {
          name: "preventLearning",
          in: "query",
          required: false,
          description:
            "Prevent automatic relearning of removed facts. Explicitly saving a fact again clears its restriction.",
          schema: { type: "boolean", default: true },
        },
      ],
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 200: json(OKSchema), 400: error, 404: error, 409: error },
    }),
    async (c) => {
      const preventLearning = z
        .enum(["true", "false"])
        .default("true")
        .safeParse(c.req.query("preventLearning"));
      if (!preventLearning.success)
        return c.json({ error: "preventLearning must be true or false." }, 400);
      await forgetHomeMemory(
        c.get("user").id,
        c.req.param("agentId"),
        undefined,
        undefined,
        preventLearning.data === "true",
      );
      return c.json({ ok: true }, 200);
    },
  );
  return route;
}
