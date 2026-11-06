import { Hono } from "hono";
import { z } from "zod";
import {
  homeMemoryInputSchema,
  homeMemoryPatchSchema,
  homeMemorySettingsSchema,
} from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { jsonValidator } from "../validation.ts";
import { HomeError } from "../services/agent-homes.ts";
import {
  readHomeMemoryOverview,
  setHomeMemorySettings,
  saveHomeMemory,
  editHomeMemory,
  forgetHomeMemory,
  homeMemoryHistory,
  restoreHomeMemory,
} from "../services/home-memory.ts";

export function createHomeMemoryRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof HomeError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  const path = "/agents/:agentId/home/memory";
  route.get(path, (c) =>
    c.json(
      readHomeMemoryOverview(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.query("q")?.slice(0, 200) ?? "",
        Math.max(0, Math.min(100000, Number(c.req.query("offset")) || 0)),
      ),
    ),
  );
  route.patch(`${path}/settings`, jsonValidator(homeMemorySettingsSchema), (c) => {
    const settings = setHomeMemorySettings(
      c.get("user").id,
      c.req.param("agentId"),
      c.req.valid("json"),
    );
    return c.json({ mode: settings.mode });
  });
  route.post(path, jsonValidator(homeMemoryInputSchema), (c) =>
    c.json(saveHomeMemory(c.get("user").id, c.req.param("agentId"), c.req.valid("json")), 201),
  );
  route.patch(`${path}/:id`, jsonValidator(homeMemoryPatchSchema), (c) =>
    c.json(
      editHomeMemory(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("id"),
        c.req.valid("json"),
      ),
    ),
  );
  route.get(`${path}/:id/history`, (c) =>
    c.json(homeMemoryHistory(c.get("user").id, c.req.param("agentId"), c.req.param("id"))),
  );
  route.post(
    `${path}/:id/restore`,
    jsonValidator(
      z
        .object({
          revision: z.number().int().positive(),
          expectedRevision: z.number().int().positive(),
        })
        .strict(),
    ),
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
      );
    },
  );
  route.delete(`${path}/:id`, (c) => {
    const revision = Number(c.req.query("revision"));
    if (!Number.isSafeInteger(revision) || revision < 1)
      return c.json({ error: "A memory revision is required." }, 400);
    forgetHomeMemory(c.get("user").id, c.req.param("agentId"), c.req.param("id"), revision);
    return c.json({ ok: true });
  });
  route.delete(path, (c) => {
    forgetHomeMemory(c.get("user").id, c.req.param("agentId"));
    return c.json({ ok: true });
  });
  return route;
}
