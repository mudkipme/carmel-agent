import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { success, createRouter, error, json } from "../openapi/routes.ts";
import { HelperSummarySchema, SessionSchema } from "../openapi/schemas.ts";
import { eq } from "drizzle-orm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { helperHosts, sessions } from "../db/schema.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { readPiSessionPage, withPiSession } from "../services/pi-session-storage.ts";
import { serializeSession } from "../serializers.ts";
import { readHelpers, stopHelper } from "../runtime/helpers.ts";
import { resumeHelperHost, stopAllHelpers } from "../runtime/helper-hosts.ts";

export function createHelperRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  route.use("/sessions/:id/helpers/*", async (c, next) => {
    const row = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, c.req.param("id")!))
      .get();
    if (!row || row.userId !== c.get("user").id || !readVisibleAgent(row.userId, row.agentId))
      return c.json({ error: "Session not found." }, 404);
    await next();
  });
  route.openapi(
    createRoute({
      method: "get",
      path: "/sessions/{id}/helpers",
      operationId: "getSessionHelpers",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: json(
          z.object({
            helpers: z.array(HelperSummarySchema),
            error: z.string().nullable(),
            tasks: z.array(
              z.object({
                id: z.number().int(),
                kind: z.string(),
                state: z.string(),
                background: z.boolean(),
              }),
            ),
          }),
          "Helper state",
        ),
        404: error,
      },
    }),
    async (c) => {
      const row = db
        .select()
        .from(sessions)
        .where(eq(sessions.id, c.req.param("id")))
        .get();
      if (!row || row.userId !== c.get("user").id || !readVisibleAgent(row.userId, row.agentId))
        return c.json({ error: "Session not found." }, 404);
      return withPiSession(row.id, async (pi) => {
        const inspection = await pi.native.inspect(BACKGROUND_CONTEXT);
        return c.json(
          {
            helpers: await readHelpers(pi),
            error:
              db.select().from(helperHosts).where(eq(helperHosts.sessionId, row.id)).get()?.error ??
              null,
            tasks: inspection.tasks.map((task) => ({
              id: task.record.id,
              kind: task.record.kind,
              state: task.state.kind,
              background: task.record.background,
            })),
          },
          200,
        );
      });
    },
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/sessions/{id}/helpers/{helperId}",
      operationId: "getSessionHelper",
      tags: ["Sessions"],
      parameters: [{ name: "before", in: "query", schema: { type: "string" } }],
      request: { params: z.object({ id: z.string(), helperId: z.string() }) },
      responses: {
        200: json(
          z.object({
            helper: HelperSummarySchema,
            session: SessionSchema,
          }),
          "Helper state",
        ),
        404: error,
      },
    }),
    async (c) => {
      const row = db
        .select()
        .from(sessions)
        .where(eq(sessions.id, c.req.param("id")))
        .get()!;
      if (!readVisibleAgent(row.userId, row.agentId))
        return c.json({ error: "Agent not found." }, 404);
      const helperId = Number(c.req.param("helperId"));
      return withPiSession(row.id, async (pi) => {
        const helper = (await readHelpers(pi)).find((item) => item.id === helperId);
        if (!helper) return c.json({ error: "Subtask not found." }, 404);
        const conversation = await pi.native.conversation(
          helper.id as ConversationId,
          BACKGROUND_CONTEXT,
        );
        if (!conversation) return c.json({ error: "Subtask not found." }, 404);
        const page = await readPiSessionPage({ ...pi, conversation }, c.req.query("before"));
        const messages = page.entries.flatMap((entry) => (entry.type === "message" ? [entry] : []));
        return c.json(
          {
            helper,
            session: serializeSession({
              ...row,
              messages: messages.map((entry) => entry.message),
              messageEntryIds: messages.map((entry) => entry.id),
              olderCursor: page.olderCursor,
            }),
          },
          200,
        );
      });
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/helpers/resume",
      operationId: "resumeSessionHelpers",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: success,
        404: error,
      },
    }),
    async (c) => {
      const row = db
        .select()
        .from(sessions)
        .where(eq(sessions.id, c.req.param("id")))
        .get()!;
      if (!readVisibleAgent(row.userId, row.agentId))
        return c.json({ error: "Agent not found." }, 404);
      db.update(helperHosts).set({ error: null }).where(eq(helperHosts.sessionId, row.id)).run();
      await resumeHelperHost(row.id);
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/helpers/stop",
      operationId: "stopSessionHelpers",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: success,
        404: error,
      },
    }),
    async (c) => {
      await stopAllHelpers(c.req.param("id"));
      return c.json({ ok: true }, 200);
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/helpers/{helperId}/stop",
      operationId: "stopSessionHelper",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string(), helperId: z.string() }) },
      responses: {
        200: success,
        404: error,
      },
    }),
    async (c) => {
      return withPiSession(c.req.param("id"), async (pi) => {
        const helperId = Number(c.req.param("helperId"));
        if (!(await readHelpers(pi)).some((helper) => helper.id === helperId))
          return c.json({ error: "Subtask not found." }, 404);
        await stopHelper(pi, helperId);
        return c.json({ ok: true }, 200);
      });
    },
  );
  return route;
}
