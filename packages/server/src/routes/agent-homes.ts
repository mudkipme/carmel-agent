import { imOutbox } from "../db/im-schema.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { getActiveAgentRunForSession } from "../runtime/run-stream.ts";
import { admitHomeInput, dispatchHome, stopHome } from "../services/home-events.ts";
import { agentHomes, homeEvents, sessions, issues } from "../db/schema.ts";
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
  route.get("/homes", (c) => {
    const userId = c.get("user").id;
    return c.json(
      db
        .select({ home: agentHomes, updatedAt: sessions.updatedAt })
        .from(agentHomes)
        .innerJoin(sessions, eq(sessions.id, agentHomes.sessionId))
        .where(eq(agentHomes.userId, userId))
        .all()
        .filter(({ home }) => readVisibleAgent(userId, home.agentId))
        .map(({ home, updatedAt }) => {
          const work = db
            .select({ status: issues.status })
            .from(issues)
            .where(and(eq(issues.userId, userId), eq(issues.agentId, home.agentId)))
            .all();
          return {
            agentId: home.agentId,
            sessionId: home.sessionId,
            unread: Math.max(home.updatedAt, updatedAt) > home.lastReadAt,
            working:
              Boolean(getActiveAgentRunForSession(userId, home.sessionId)) ||
              work.some((issue) => issue.status === "in_progress"),
            needsAttention: work.some((issue) =>
              ["in_review", "needs_input", "blocked"].includes(issue.status),
            ),
          };
        }),
    );
  });
  route.patch(
    "/agents/:agentId/home/read",
    jsonValidator(z.object({ readAt: z.number().int().min(0) }).strict()),
    (c) => {
      const home = readHome(c.get("user").id, c.req.param("agentId"));
      if (home)
        db.update(agentHomes)
          .set({
            lastReadAt: Math.max(home.lastReadAt, Math.min(Date.now(), c.req.valid("json").readAt)),
          })
          .where(eq(agentHomes.sessionId, home.sessionId))
          .run();
      return c.json({ ok: true });
    },
  );
  route.post("/agents/:agentId/home/resume", async (c) => {
    const home = readHome(c.get("user").id, c.req.param("agentId"));
    if (home) {
      db.update(agentHomes)
        .set({ paused: false })
        .where(eq(agentHomes.sessionId, home.sessionId))
        .run();
      await dispatchHome(home.sessionId);
    }
    return c.json({ ok: true });
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
          .map(({ id, status, error, createdAt, kind }) => ({ id, status, error, createdAt, kind }))
      : [];
    const session = home
      ? db
          .select({ updatedAt: sessions.updatedAt })
          .from(sessions)
          .where(eq(sessions.id, home.sessionId))
          .get()
      : undefined;
    const deliveries = home
      ? db
          .select({
            id: imOutbox.id,
            status: imOutbox.status,
            error: imOutbox.error,
            eventId: imOutbox.homeEventId,
          })
          .from(imOutbox)
          .innerJoin(homeEvents, eq(homeEvents.id, imOutbox.homeEventId))
          .where(eq(homeEvents.sessionId, home.sessionId))
          .orderBy(desc(imOutbox.createdAt))
          .limit(10)
          .all()
      : [];
    return c.json({
      home: home
        ? { ...home, activityAt: Math.max(home.updatedAt, session?.updatedAt ?? 0) }
        : null,
      events,
      deliveries,
    });
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
