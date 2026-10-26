import { admitHomeInput, dispatchHome, stopHome } from "../services/home-events.ts";
import { homeEvents } from "../db/schema.ts";
import { db } from "../db/index.ts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agentRunRequestSchema } from "@carmel-agent/shared";
import { z } from "zod";
import { jsonValidator } from "../validation.ts";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { ensureHome, HomeError, readHome, resetHome } from "../services/agent-homes.ts";
import { readSessionSnapshot } from "../services/session-snapshot.ts";

export function createHomeRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof HomeError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  route.get("/agents/:agentId/home", async (c) => {
    const home = readHome(c.get("user").id, c.req.param("agentId"));
    const events = home
      ? db
          .select()
          .from(homeEvents)
          .where(
            and(
              eq(homeEvents.sessionId, home.sessionId),
              inArray(homeEvents.status, [
                "preparing",
                "queued",
                "running",
                "failed",
                "interrupted",
              ]),
            ),
          )
          .orderBy(desc(homeEvents.createdAt))
          .limit(30)
          .all()
          .map(({ id, status, error, createdAt }) => ({ id, status, error, createdAt }))
      : [];
    return c.json({ home: home ?? null, events });
  });
  route.post("/agents/:agentId/home", async (c) => {
    const home = ensureHome(c.get("user").id, c.req.param("agentId"));
    return c.json({ home, session: await readSessionSnapshot(c.get("user").id, home.sessionId) });
  });
  route.post("/agents/:agentId/home/reset", async (c) => {
    await resetHome(c.get("user").id, c.req.param("agentId"));
    return c.json({ ok: true });
  });
  route.post(
    "/agents/:agentId/home/messages",
    jsonValidator(agentRunRequestSchema.extend({ requestId: z.string().min(1).max(200) })),
    async (c) => {
      const input = c.req.valid("json");
      if (!input.promptInput) return c.json({ error: "A message is required." }, 400);
      const event = admitHomeInput(c.get("user").id, c.req.param("agentId"), {
        sourceKey: `web:${input.requestId}`,
        origin: "web",
        prompt: input.promptInput,
        modelRefId: input.modelRefId,
        thinkingLevel: input.thinkingLevel,
        timezone: input.timezone,
      });
      const run = await dispatchHome(event.sessionId);
      return c.json({ eventId: event.id, runId: run?.runId }, 202);
    },
  );
  route.post("/agents/:agentId/home/stop", async (c) => {
    await stopHome(c.get("user").id, c.req.param("agentId"));
    return c.json({ ok: true });
  });
  return route;
}
