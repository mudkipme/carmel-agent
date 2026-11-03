import { Hono } from "hono";
import { collaborationConnectionSchema } from "@carmel-agent/shared";
import { eq, or, and } from "drizzle-orm";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { collaborations } from "../db/schema.ts";
import { jsonValidator } from "../validation.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import {
  CollaborationError,
  readConnections,
  saveConnection,
  cancelCollaboration,
} from "../services/collaborations.ts";

export function createCollaborationRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof CollaborationError) return c.json({ error: error.message }, 403);
    throw error;
  });
  route.get("/agents/:agentId/collaboration-connections", (c) =>
    c.json(readConnections(c.get("user").id, c.req.param("agentId"))),
  );
  route.put(
    "/agents/:agentId/collaboration-connections",
    jsonValidator(collaborationConnectionSchema),
    (c) => c.json(saveConnection(c.get("user").id, c.req.param("agentId"), c.req.valid("json"))),
  );
  route.get("/agents/:agentId/collaborations", (c) => {
    const userId = c.get("user").id;
    const agentId = c.req.param("agentId");
    if (!readVisibleAgent(userId, agentId)) return c.json({ error: "Agent not found." }, 404);
    return c.json(
      db
        .select()
        .from(collaborations)
        .where(
          and(
            eq(collaborations.userId, userId),
            or(
              eq(collaborations.sourceAgentId, agentId),
              eq(collaborations.targetAgentId, agentId),
            ),
          ),
        )
        .all()
        .map((row) => ({ ...row, sourceKey: undefined })),
    );
  });
  route.post("/agents/:agentId/collaborations/:id/cancel", (c) => {
    const userId = c.get("user").id;
    const row = db
      .select()
      .from(collaborations)
      .where(
        and(
          eq(collaborations.id, c.req.param("id")),
          eq(collaborations.userId, userId),
          eq(collaborations.sourceAgentId, c.req.param("agentId")),
        ),
      )
      .get();
    if (!row) return c.json({ error: "Collaboration not found." }, 404);
    return c.json(
      cancelCollaboration(
        { userId, agentId: row.sourceAgentId, sessionId: row.sourceSessionId },
        row.id,
      ),
    );
  });
  return route;
}
