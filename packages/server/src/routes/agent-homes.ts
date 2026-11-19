import { createRoute } from "@hono/zod-openapi";
import { success, createRouter, error, json, jsonBody } from "../openapi/routes.ts";
import { HomeSummarySchema, HomeStatusSchema, SessionSchema } from "../openapi/schemas.ts";
import { imOutbox } from "../db/im-schema.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { getActiveAgentRunForSession } from "../runtime/run-stream.ts";
import { admitHomeInput, dispatchHome, stopHome } from "../services/home-events.ts";
import { agentHomes, homeEvents, sessions, issues } from "../db/schema.ts";
import { db } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agentRunRequestSchema } from "@carmel-agent/shared";
import { z } from "zod";
import type { AuthVariables } from "../auth.ts";
import { ensureHome, HomeError, readHome, resetHome } from "../services/agent-homes.ts";
import { readSessionSnapshot } from "../services/session-snapshot.ts";

export function createHomeRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof HomeError) return c.json({ error: error.message }, error.status);
    throw error;
  });
  route.openapi(
    createRoute({
      method: "get",
      path: "/homes",
      operationId: "listHomeSummaries",
      tags: ["Agents"],
      summary: "List private Home unread and work state",
      responses: { 200: json(z.array(HomeSummarySchema)), 400: error, 404: error, 409: error },
    }),
    (c) => {
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
        200,
      );
    },
  );
  route.openapi(
    createRoute({
      method: "patch",
      path: "/agents/{agentId}/home/read",
      operationId: "readAgentHome",
      tags: ["Agents"],
      summary: "Mark observed Home history read",
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(z.object({ readAt: z.number().int().min(0) }).strict()),
      },
      responses: { 200: success, 400: error, 404: error, 409: error },
    }),
    (c) => {
      const home = readHome(c.get("user").id, c.req.param("agentId"));
      if (home)
        db.update(agentHomes)
          .set({
            lastReadAt: Math.max(home.lastReadAt, Math.min(Date.now(), c.req.valid("json").readAt)),
          })
          .where(eq(agentHomes.sessionId, home.sessionId))
          .run();
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/resume",
      operationId: "resumeAgentHome",
      tags: ["Agents"],
      summary: "Resume automated Home updates",
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 200: success, 400: error, 404: error, 409: error },
    }),
    async (c) => {
      const home = readHome(c.get("user").id, c.req.param("agentId"));
      if (home) {
        db.update(agentHomes)
          .set({ paused: false })
          .where(eq(agentHomes.sessionId, home.sessionId))
          .run();
        await dispatchHome(home.sessionId);
      }
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/home",
      operationId: "getAgentHome",
      tags: ["Agents"],
      summary: "Read Home and pending input/delivery state",
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 200: json(HomeStatusSchema), 400: error, 404: error, 409: error },
    }),
    async (c) => {
      const home = readHome(c.get("user").id, c.req.param("agentId"));
      const latestSettled = home
        ? db
            .select({ id: homeEvents.id, status: homeEvents.status })
            .from(homeEvents)
            .where(
              and(
                eq(homeEvents.sessionId, home.sessionId),
                inArray(homeEvents.kind, ["input", "issue", "collaboration"]),
                inArray(homeEvents.status, ["done", "failed", "interrupted", "cancelled"]),
              ),
            )
            .orderBy(
              desc(sql`coalesce(${homeEvents.finishedAt}, ${homeEvents.createdAt})`),
              desc(sql`rowid`),
            )
            .limit(1)
            .get()
        : undefined;
      const latestFailed =
        latestSettled?.status === "failed" || latestSettled?.status === "interrupted";
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
            .orderBy(desc(homeEvents.createdAt), desc(sql`rowid`))
            .limit(30)
            .all()
            .map(({ id, status, error, errorDismissedAt, createdAt, kind }) => ({
              id,
              status,
              createdAt,
              kind,
              error:
                latestFailed && id === latestSettled?.id && !errorDismissedAt ? error : undefined,
            }))
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
      return c.json(
        {
          home: home
            ? { ...home, activityAt: Math.max(home.updatedAt, session?.updatedAt ?? 0) }
            : null,
          events,
          deliveries,
        },
        200,
      );
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/events/{eventId}/dismiss",
      operationId: "dismissAgentHomeError",
      tags: ["Agents"],
      summary: "Dismiss a Home failure notice",
      request: { params: z.object({ agentId: z.string(), eventId: z.string() }) },
      responses: { 200: success, 400: error, 404: error, 409: error },
    }),
    (c) => {
      const home = readHome(c.get("user").id, c.req.param("agentId"));
      if (home)
        db.update(homeEvents)
          .set({ errorDismissedAt: now() })
          .where(
            and(
              eq(homeEvents.id, c.req.param("eventId")),
              eq(homeEvents.sessionId, home.sessionId),
            ),
          )
          .run();
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home",
      operationId: "ensureAgentHome",
      tags: ["Agents"],
      summary: "Create or adopt Home without running the model",
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(z.object({ home: z.object({ sessionId: z.string() }), session: SessionSchema })),
        400: error,
        404: error,
        409: error,
      },
    }),
    async (c) => {
      const home = ensureHome(c.get("user").id, c.req.param("agentId"));
      const session = await readSessionSnapshot(c.get("user").id, home.sessionId);
      if (!session) return c.json({ error: "Session not found." }, 404);
      return c.json({ home, session }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/reset",
      operationId: "resetAgentHome",
      tags: ["Agents"],
      summary: "Begin fresh model context while retaining history",
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 200: success, 400: error, 404: error, 409: error },
    }),
    async (c) => {
      await resetHome(c.get("user").id, c.req.param("agentId"));
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/messages",
      operationId: "sendHomeMessage",
      tags: ["Agents"],
      summary: "Queue origin-aware Home input",
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(agentRunRequestSchema.extend({ requestId: z.string().min(1).max(200) })),
      },
      responses: {
        202: json(z.object({ eventId: z.string(), runId: z.string().optional() })),
        400: error,
        404: error,
        409: error,
      },
    }),
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
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/home/stop",
      operationId: "stopAgentHome",
      tags: ["Agents"],
      summary: "Stop Home and clear pending user inputs across channels",
      request: { params: z.object({ agentId: z.string() }) },
      responses: { 200: success, 400: error, 404: error, 409: error },
    }),
    async (c) => {
      await stopHome(c.get("user").id, c.req.param("agentId"));
      return c.json({ ok: true }, 200);
    },
  );
  return route;
}
