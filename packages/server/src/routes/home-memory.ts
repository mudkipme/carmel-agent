import { Hono } from "hono";
import { z } from "zod";
import {
  homeMemoryInputSchema,
  homeMemoryPatchSchema,
  homeMemorySettingsSchema,
  homeMemorySearchSchema,
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
  route.post(
    `${path}/refresh`,
    jsonValidator(
      z
        .object({
          embed: z.boolean().default(false),
          allowDownloads: z.boolean().default(false),
          deep: z.boolean().default(false),
        })
        .strict(),
    ),
    async (c) => {
      await refreshHomeMemoryIndex(c.get("user").id, c.req.param("agentId"), c.req.valid("json"));
      return c.json({ ok: true }, 202);
    },
  );
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
