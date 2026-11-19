import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody, success } from "../openapi/routes.ts";
import { AgentSecretRequestSchema, EnvironmentSecretSchema } from "../openapi/schemas.ts";
import type { AuthVariables } from "../auth.ts";
import {
  SecretError,
  deleteEnvironmentSecret,
  environmentWorkspaceDotEnvStatus,
  importEnvironmentWorkspaceDotEnv,
  readEnvironmentSecrets,
  writeEnvironmentSecret,
} from "../services/environment-secrets.ts";

/**
 * Secrets are addressed under their environment and are write-only over the
 * API: there is no route that returns a value, so a compromised session cookie
 * can rotate a credential but cannot read one back out.
 */
export function createEnvironmentSecretRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof SecretError) return c.json({ error: error.message }, error.status);
    throw error;
  });

  route.openapi(
    createRoute({
      method: "get",
      path: "/environments/{environmentId}/secrets",
      operationId: "listEnvironmentSecrets",
      tags: ["Secrets"],
      request: { params: z.object({ environmentId: z.string() }) },
      responses: { 200: json(z.array(EnvironmentSecretSchema), "Secret names"), 403: error },
    }),
    (c) => c.json(readEnvironmentSecrets(c.get("user").id, c.req.param("environmentId")), 200),
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/environments/{environmentId}/secrets/import-env",
      operationId: "getEnvironmentWorkspaceDotEnvStatus",
      tags: ["Secrets"],
      parameters: [{ name: "agent", in: "query", required: true, schema: { type: "string" } }],
      request: { params: z.object({ environmentId: z.string() }) },
      responses: {
        200: json(z.object({ available: z.boolean() }), "Workspace .env availability"),
        403: error,
        404: error,
      },
    }),
    (c) =>
      c.json(
        environmentWorkspaceDotEnvStatus(
          c.get("user").id,
          c.req.param("environmentId"),
          c.req.query("agent") ?? "",
        ),
        200,
      ),
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/environments/{environmentId}/secrets/import-env",
      operationId: "importEnvironmentWorkspaceDotEnv",
      tags: ["Secrets"],
      parameters: [{ name: "agent", in: "query", required: true, schema: { type: "string" } }],
      request: { params: z.object({ environmentId: z.string() }) },
      responses: {
        200: json(
          z.object({
            imported: z.number().int(),
            skippedExisting: z.number().int(),
            skippedInvalid: z.number().int(),
          }),
          "Import counts without secret values",
        ),
        403: error,
        404: error,
      },
    }),
    (c) =>
      c.json(
        importEnvironmentWorkspaceDotEnv(
          c.get("user").id,
          c.req.param("environmentId"),
          c.req.query("agent") ?? "",
        ),
        200,
      ),
  );

  route.openapi(
    createRoute({
      method: "put",
      path: "/environments/{environmentId}/secrets/{name}",
      operationId: "writeEnvironmentSecret",
      tags: ["Secrets"],
      request: {
        params: z.object({ environmentId: z.string(), name: z.string() }),
        body: jsonBody(AgentSecretRequestSchema),
      },
      responses: { 200: json(EnvironmentSecretSchema, "Secret"), 400: error, 403: error },
    }),
    (c) =>
      c.json(
        writeEnvironmentSecret(
          c.get("user").id,
          c.req.param("environmentId"),
          c.req.param("name"),
          c.req.valid("json").value,
        ),
        200,
      ),
  );

  route.openapi(
    createRoute({
      method: "delete",
      path: "/environments/{environmentId}/secrets/{name}",
      operationId: "deleteEnvironmentSecret",
      tags: ["Secrets"],
      request: { params: z.object({ environmentId: z.string(), name: z.string() }) },
      responses: { 200: success, 403: error, 404: error },
    }),
    (c) => {
      deleteEnvironmentSecret(c.get("user").id, c.req.param("environmentId"), c.req.param("name"));
      return c.json({ ok: true }, 200);
    },
  );

  return route;
}
