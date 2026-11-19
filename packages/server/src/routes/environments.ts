import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json, jsonBody, success } from "../openapi/routes.ts";
import { EnvironmentSchema, EnvironmentRequestSchema } from "../openapi/schemas.ts";
import type { AuthVariables } from "../auth.ts";
import { readActiveRunLeaseForEnvironment } from "../services/active-run-lease.ts";
import {
  EnvironmentError,
  closeEnvironmentSessions,
  deleteEnvironment,
  readOwnedEnvironment,
  readOwnedEnvironments,
  serializeEnvironment,
  writeEnvironment,
} from "../services/environments.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";

export function createEnvironmentRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof EnvironmentError) return c.json({ error: error.message }, error.status);
    throw error;
  });

  route.openapi(
    createRoute({
      method: "get",
      path: "/environments",
      operationId: "listEnvironments",
      tags: ["Environments"],
      responses: { 200: json(z.array(EnvironmentSchema), "The caller's environments") },
    }),
    (c) => c.json(readOwnedEnvironments(c.get("user").id).map(serializeEnvironment), 200),
  );

  route.openapi(
    createRoute({
      method: "post",
      path: "/environments",
      operationId: "createEnvironment",
      tags: ["Environments"],
      request: { body: jsonBody(EnvironmentRequestSchema) },
      responses: { 200: json(EnvironmentSchema, "Environment"), 403: error },
    }),
    (c) => c.json(serializeEnvironment(writeEnvironment(c.get("user"), c.req.valid("json"))), 200),
  );

  route.openapi(
    createRoute({
      method: "put",
      path: "/environments/{id}",
      operationId: "updateEnvironment",
      tags: ["Environments"],
      request: { params: z.object({ id: z.string() }), body: jsonBody(EnvironmentRequestSchema) },
      responses: {
        200: json(EnvironmentSchema, "Environment"),
        403: error,
        404: error,
        409: error,
      },
    }),
    (c) => {
      const user = c.get("user");
      const current = readOwnedEnvironment(user.id, c.req.param("id"));
      if (!current) return c.json({ error: "Environment not found." }, 404);
      const activeRun = readActiveRunLeaseForEnvironment(current.id);
      if (activeRun) return activeRunConflictResponse(c, activeRun);
      const environment = writeEnvironment(user, c.req.valid("json"), current);
      closeEnvironmentSessions(environment.id, "The environment settings changed.");
      return c.json(serializeEnvironment(environment), 200);
    },
  );

  route.openapi(
    createRoute({
      method: "delete",
      path: "/environments/{id}",
      operationId: "deleteEnvironment",
      tags: ["Environments"],
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: success, 404: error, 409: error },
    }),
    async (c) => {
      const environment = readOwnedEnvironment(c.get("user").id, c.req.param("id"));
      if (!environment) return c.json({ error: "Environment not found." }, 404);
      await deleteEnvironment(environment);
      return c.json({ ok: true }, 200);
    },
  );

  return route;
}
