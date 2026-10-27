import { Hono } from "hono";
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
  const route = new Hono<{ Variables: AuthVariables }>();
  route.use("/sessions/:id/helpers/*", async (c, next) => {
    const row = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, c.req.param("id")!))
      .get();
    if (!row || row.userId !== c.get("user").id)
      return c.json({ error: "Session not found." }, 404);
    await next();
  });
  route.get("/sessions/:id/helpers", async (c) => {
    const row = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, c.req.param("id")))
      .get();
    if (!row || row.userId !== c.get("user").id || !readVisibleAgent(row.userId, row.agentId))
      return c.json({ error: "Session not found." }, 404);
    return withPiSession(row.id, async (pi) => {
      const inspection = await pi.native.inspect(BACKGROUND_CONTEXT);
      return c.json({
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
      });
    });
  });
  route.get("/sessions/:id/helpers/:helperId", async (c) => {
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
      return c.json({
        helper,
        session: serializeSession({
          ...row,
          messages: messages.map((entry) => entry.message),
          messageEntryIds: messages.map((entry) => entry.id),
          olderCursor: page.olderCursor,
        }),
      });
    });
  });
  route.post("/sessions/:id/helpers/resume", async (c) => {
    const row = db
      .select()
      .from(sessions)
      .where(eq(sessions.id, c.req.param("id")))
      .get()!;
    if (!readVisibleAgent(row.userId, row.agentId))
      return c.json({ error: "Agent not found." }, 404);
    db.update(helperHosts).set({ error: null }).where(eq(helperHosts.sessionId, row.id)).run();
    await resumeHelperHost(row.id, true);
    return c.json({ ok: true });
  });
  route.post("/sessions/:id/helpers/stop", async (c) => {
    await stopAllHelpers(c.req.param("id"));
    return c.json({ ok: true });
  });
  route.post("/sessions/:id/helpers/:helperId/stop", async (c) => {
    return withPiSession(c.req.param("id"), async (pi) => {
      const helperId = Number(c.req.param("helperId"));
      if (!(await readHelpers(pi)).some((helper) => helper.id === helperId))
        return c.json({ error: "Subtask not found." }, 404);
      await stopHelper(pi, helperId);
      return c.json({ ok: true });
    });
  });
  return route;
}
