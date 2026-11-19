import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody, success } from "../openapi/routes.ts";
import {
  ApiKeySchema,
  ApiKeyCreateRequestSchema,
  ApiKeyCreatedSchema,
} from "../openapi/schemas.ts";
import type { AuthVariables } from "../auth.ts";
import { createApiKey, deleteApiKey, readApiKeys } from "../services/api-keys.ts";

/**
 * Keys for the OpenAI-compatible `/api/v1` API. Managed only from a signed-in
 * session: a key cannot mint or list other keys, so one leaked key stays one
 * key the owner can revoke here.
 */
export function createApiKeyRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.openapi(
    createRoute({
      method: "get",
      path: "/api-keys",
      operationId: "listApiKeys",
      tags: ["Users"],
      description: "Keys for the OpenAI-compatible /v1 API. Never includes the key itself.",
      responses: { 200: json(z.array(ApiKeySchema), "API keys") },
    }),
    (c) => c.json(readApiKeys(c.get("user").id), 200),
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/api-keys",
      operationId: "createApiKey",
      tags: ["Users"],
      description: "The only response that carries the key; it cannot be read back later.",
      request: { body: jsonBody(ApiKeyCreateRequestSchema) },
      responses: { 201: json(ApiKeyCreatedSchema, "Created key"), 400: error },
    }),
    (c) => c.json(createApiKey(c.get("user").id, c.req.valid("json").name), 201),
  );

  route.openapi(
    createRoute({
      method: "delete",
      path: "/api-keys/{id}",
      operationId: "deleteApiKey",
      tags: ["Users"],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: success, 404: error },
    }),
    (c) => {
      if (!deleteApiKey(c.get("user").id, c.req.param("id")))
        return c.json({ error: "API key not found." }, 404);
      return c.json({ ok: true }, 200);
    },
  );

  return route;
}
