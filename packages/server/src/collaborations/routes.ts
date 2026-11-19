import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody } from "../openapi/routes.ts";
import {
  CollaborationConnectionSchema,
  CollaborationSummarySchema,
  CollaboratorSchema,
} from "../openapi/schemas.ts";
import { collaborationConnectionSchema } from "@carmel-agent/shared";
import { eq, or, and } from "drizzle-orm";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { collaborations } from "../db/schema.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import {
  CollaborationError,
  readConnections,
  readCollaborators,
  saveConnection,
  cancelCollaboration,
} from "./service.ts";

export function createCollaborationRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof CollaborationError) return c.json({ error: error.message }, 403);
    throw error;
  });
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/collaborators",
      operationId: "getCollaborators",
      tags: ["Agents"],
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(
          z.array(CollaboratorSchema),
          "Agents this user and source agent may contact, with their capabilities.",
        ),
        403: error,
      },
    }),
    (c) => c.json(readCollaborators(c.get("user").id, c.req.param("agentId")), 200),
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/collaboration-connections",
      operationId: "getCollaborationConnections",
      tags: ["Agents"],
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(
          z.array(CollaborationConnectionSchema),
          "Owner-managed directional collaboration grants.",
        ),
        403: error,
      },
    }),
    (c) => c.json(readConnections(c.get("user").id, c.req.param("agentId")), 200),
  );
  route.openapi(
    createRoute({
      method: "put",
      path: "/agents/{agentId}/collaboration-connections",
      operationId: "saveCollaborationConnection",
      tags: ["Agents"],
      request: {
        params: z.object({ agentId: z.string() }),
        body: jsonBody(collaborationConnectionSchema),
      },
      responses: {
        200: json(z.array(CollaborationConnectionSchema), "Saved connections."),
        403: error,
      },
    }),
    (c) =>
      c.json(saveConnection(c.get("user").id, c.req.param("agentId"), c.req.valid("json")), 200),
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/agents/{agentId}/collaborations",
      operationId: "getCollaborations",
      tags: ["Agents"],
      request: { params: z.object({ agentId: z.string() }) },
      responses: {
        200: json(
          z.array(CollaborationSummarySchema),
          "This user's explicit collaborations involving this agent.",
        ),
        404: error,
      },
    }),
    (c) => {
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
        200,
      );
    },
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/agents/{agentId}/collaborations/{id}/cancel",
      operationId: "cancelCollaboration",
      tags: ["Agents"],
      request: { params: z.object({ agentId: z.string(), id: z.string() }) },
      responses: {
        200: json(
          z.object({ cancelled: z.boolean().optional() }),
          "Outstanding delegated work stopped; existing changes are retained.",
        ),
        403: error,
        404: error,
      },
    }),
    (c) => {
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
        200,
      );
    },
  );
  return route;
}
