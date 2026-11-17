import { Hono } from "hono";
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
import { dreamHomeMemories, tidyHomeMemories } from "../services/home-memory-upkeep.ts";

import { refreshHomeMemoryIndex, searchHomeMemory } from "../services/home-memory-search.ts";

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
    return c.json({ mode: settings.mode, retrieval: settings.retrieval });
  });
  route.post(`${path}/search`, jsonValidator(homeMemorySearchSchema), async (c) =>
    c.json(
      await searchHomeMemory(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.valid("json"),
        c.req.raw.signal,
      ),
    ),
  );
  route.post(`${path}/refresh`, jsonValidator(indexRefreshSchema), async (c) => {
    await refreshHomeMemoryIndex(c.get("user").id, c.req.param("agentId"), c.req.valid("json"));
    return c.json({ ok: true }, 202);
  });
  route.post(`${path}/tidy`, async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = homeMemoryTidySchema.safeParse(raw ?? {});
    if (!parsed.success) return c.json({ error: "Invalid tidy options." }, 400);
    const userId = c.get("user").id;
    const agentId = c.req.param("agentId");
    const tidy = await tidyHomeMemories(userId, agentId);
    const dream = parsed.data.dream ? await dreamHomeMemories(userId, agentId) : null;
    return c.json({ tidy, dream });
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
  route.delete(`${path}/:id`, async (c) => {
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
    return c.json({ ok: true });
  });
  route.delete(path, async (c) => {
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
    return c.json({ ok: true });
  });
  return route;
}
