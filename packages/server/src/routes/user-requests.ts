import type { Context } from "hono";
import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json } from "../openapi/routes.ts";
import { OKSchema, SessionSecretSchema, UserRequestSchema } from "../openapi/schemas.ts";
import { and, eq } from "drizzle-orm";
import { secretAnswerSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { userRequests } from "../db/schema.ts";
import {
  SecretError,
  assertSessionOwner,
  demoteEnvironmentSecret,
  promoteSessionSecret,
  readSessionSecrets,
  revokeSessionSecret,
} from "../services/environment-secrets.ts";
import {
  answerQuestion,
  answerSecretRequest,
  cancelUserRequest,
  useAvailableSecret,
} from "../services/user-requests.ts";
import { withPiSession } from "../services/pi-session-storage.ts";
import { getActiveAgentRunForSession } from "../runtime/run-stream.ts";

export function createUserRequestRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  // The credential body is deliberately outside generic validators/loggers.
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/requests/{requestId}/secret",
      operationId: "provideRequestedSecret",
      tags: ["Sessions"],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/SecretAnswerRequest" } },
        },
      },
      request: { params: z.object({ id: z.string(), requestId: z.string() }) },
      responses: {
        403: error,
        500: error,
        200: json(UserRequestSchema, "Safe request receipt. Credential values are never returned."),
        400: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) =>
      respond(c, async () => {
        await writableRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
        const body = secretAnswerSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) throw new SecretError("Invalid secret value.", 400);
        return answerSecretRequest(
          c.get("user").id,
          c.req.param("id"),
          c.req.param("requestId"),
          body.data.value,
        );
      }),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/requests/{requestId}/answer",
      operationId: "answerUserQuestion",
      tags: ["Sessions"],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/QuestionAnswerRequest" } },
        },
      },
      request: { params: z.object({ id: z.string(), requestId: z.string() }) },
      responses: {
        403: error,
        500: error,
        200: json(UserRequestSchema, "Safe request receipt. Credential values are never returned."),
        400: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) =>
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
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/requests/{requestId}/cancel",
      operationId: "cancelUserRequest",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string(), requestId: z.string() }) },
      responses: {
        403: error,
        500: error,
        200: json(UserRequestSchema, "Safe request receipt. Credential values are never returned."),
        400: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) =>
      respond(c, async () => {
        await writableRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
        return cancelUserRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
      }),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/requests/{requestId}/use-existing",
      operationId: "useRequestedSecret",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string(), requestId: z.string() }) },
      responses: {
        403: error,
        500: error,
        200: json(UserRequestSchema, "Safe request receipt. Credential values are never returned."),
        400: error,
        404: error,
        409: error,
        503: error,
      },
    }),
    async (c) =>
      respond(c, async () => {
        await writableRequest(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
        return useAvailableSecret(c.get("user").id, c.req.param("id"), c.req.param("requestId"));
      }),
  );
  route.openapi(
    createRoute({
      method: "get",
      path: "/sessions/{id}/secrets",
      operationId: "listSessionSecrets",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        400: error,
        403: error,
        409: error,
        500: error,
        503: error,
        200: json(z.array(SessionSecretSchema), "Effective credential metadata, without values."),
        404: error,
      },
    }),
    (c) => respond(c, () => readSessionSecrets(c.get("user").id, c.req.param("id"))),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/secrets/{secretId}/promote",
      operationId: "promoteSessionSecret",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string(), secretId: z.string() }) },
      responses: {
        400: error,
        500: error,
        503: error,
        200: json(SessionSecretSchema, "Credential scope updated or credential revoked."),
        403: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        promoteSessionSecret(c.get("user").id, c.req.param("id"), c.req.param("secretId")),
      ),
  );
  route.openapi(
    createRoute({
      method: "post",
      path: "/sessions/{id}/secrets/{secretId}/demote",
      operationId: "demoteEnvironmentSecret",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string(), secretId: z.string() }) },
      responses: {
        400: error,
        500: error,
        503: error,
        200: json(SessionSecretSchema, "Credential scope updated or credential revoked."),
        403: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () =>
        demoteEnvironmentSecret(c.get("user").id, c.req.param("id"), c.req.param("secretId")),
      ),
  );
  route.openapi(
    createRoute({
      method: "delete",
      path: "/sessions/{id}/secrets/{secretId}",
      operationId: "revokeSessionSecret",
      tags: ["Sessions"],
      request: { params: z.object({ id: z.string(), secretId: z.string() }) },
      responses: {
        400: error,
        503: error,
        500: error,
        200: json(OKSchema, "Credential scope updated or credential revoked."),
        403: error,
        404: error,
        409: error,
      },
    }),
    (c) =>
      respond(c, () => {
        revokeSessionSecret(c.get("user").id, c.req.param("id"), c.req.param("secretId"));
        return { ok: true };
      }),
  );
  return route;
}

async function writableRequest(userId: string, sessionId: string, requestId: string) {
  const session = assertSessionOwner(userId, sessionId);
  if (session.issueId) throw new SecretError("Issue attempt history is read-only.", 409);
  const request = db
    .select()
    .from(userRequests)
    .where(and(eq(userRequests.id, requestId), eq(userRequests.sessionId, sessionId)))
    .get();
  if (!request) throw new SecretError("Request not found.", 404);
  await withPiSession(sessionId, async (pi) => {
    if (request.conversationId !== String(pi.conversation.id))
      throw new SecretError("This request belongs to an earlier conversation branch.", 409);
  });
  if (getActiveAgentRunForSession(userId, sessionId))
    throw new SecretError("Wait for the current run to finish before responding.", 409);
}

async function respond<T>(c: Context, action: () => T | Promise<T>) {
  c.header("cache-control", "no-store");
  try {
    return c.json(await action(), 200);
  } catch (error) {
    if (error instanceof SecretError) return c.json({ error: error.message }, error.status);
    // Never serialize the exception, but do not disguise a bug or database
    // failure as an unavailable service with no log line either.
    console.error("Unable to handle user request:", error);
    return c.json({ error: "Internal server error." }, 500);
  }
}
