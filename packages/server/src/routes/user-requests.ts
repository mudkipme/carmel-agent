import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { secretAnswerSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { userRequests } from "../db/schema.ts";
import {
  AgentSecretError,
  assertSessionOwner,
  demoteAgentSecret,
  promoteSessionSecret,
  readSessionSecrets,
  revokeSessionSecret,
} from "../services/agent-secrets.ts";
import {
  answerQuestion,
  answerSecretRequest,
  cancelUserRequest,
  useAvailableSecret,
} from "../services/user-requests.ts";
import { withPiSession } from "../services/pi-session-storage.ts";
import { getActiveAgentRunForSession } from "../runtime/run-stream.ts";

export function createUserRequestRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  // The credential body is deliberately outside generic validators/loggers.
  route.post("/sessions/:id/requests/:requestId/secret", async (c) =>
    respond(c, async () => {
      await writableRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
      const body = secretAnswerSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) throw new AgentSecretError("Invalid secret value.", 400);
      return answerSecretRequest(
        c.get("user").id,
        c.req.param("id"),
        c.req.param("requestId"),
        body.data.value,
      );
    }),
  );
  route.post("/sessions/:id/requests/:requestId/answer", async (c) =>
    respond(c, async () => {
      await writableRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
      return answerQuestion(
        c.get("user").id,
        c.req.param("id"),
        c.req.param("requestId"),
        await c.req.json().catch(() => undefined),
      );
    }),
  );
  route.post("/sessions/:id/requests/:requestId/cancel", async (c) =>
    respond(c, async () => {
      await writableRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
      return cancelUserRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
    }),
  );
  route.post("/sessions/:id/requests/:requestId/use-existing", async (c) =>
    respond(c, async () => {
      await writableRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
      return useAvailableSecret(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
    }),
  );
  route.get("/sessions/:id/secrets", (c) =>
    respond(c, () => readSessionSecrets(c.get("user").id, c.req.param("id"))),
  );
  route.post("/sessions/:id/secrets/:secretId/promote", (c) =>
    respond(c, () =>
      promoteSessionSecret(c.get("user").id, c.req.param("id"), c.req.param("secretId")),
    ),
  );
  route.post("/sessions/:id/secrets/:secretId/demote", (c) =>
    respond(c, () =>
      demoteAgentSecret(c.get("user").id, c.req.param("id"), c.req.param("secretId")),
    ),
  );
  route.delete("/sessions/:id/secrets/:secretId", (c) =>
    respond(c, () => {
      revokeSessionSecret(c.get("user").id, c.req.param("id"), c.req.param("secretId"));
      return { ok: true };
    }),
  );
  return route;
}

async function writableRequest(userId: string, sessionId: string, requestId: string) {
  const session = assertSessionOwner(userId, sessionId);
  if (session.issueId) throw new AgentSecretError("Issue attempt history is read-only.", 409);
  const request = db
    .select()
    .from(userRequests)
    .where(and(eq(userRequests.id, requestId), eq(userRequests.sessionId, sessionId)))
    .get();
  if (!request) throw new AgentSecretError("Request not found.", 404);
  await withPiSession(sessionId, async (pi) => {
    if (request.conversationId !== String(pi.conversation.id))
      throw new AgentSecretError("This request belongs to an earlier conversation branch.", 409);
  });
  if (getActiveAgentRunForSession(userId, sessionId))
    throw new AgentSecretError("Wait for the current run to finish before responding.", 409);
}

async function respond(
  c: {
    header: (name: string, value: string) => void;
    json: (body: unknown, status?: 200 | 400 | 403 | 404 | 409 | 503) => Response;
  },
  action: () => unknown,
) {
  c.header("cache-control", "no-store");
  try {
    return c.json(await action());
  } catch (error) {
    if (error instanceof AgentSecretError) return c.json({ error: error.message }, error.status);
    // No unknown exception or validation payload from this boundary is logged/serialized.
    return c.json({ error: "Unable to process this request." }, 503);
  }
}
