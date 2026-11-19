import { createRoute } from "@hono/zod-openapi";
import { createRouter, error, json, success } from "../openapi/routes.ts";
import { BootstrapPayloadSchema } from "../openapi/schemas.ts";
import type { AuthVariables } from "../auth.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";

export function createSystemRoutes() {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.openapi(
    createRoute({
      method: "get",
      path: "/health",
      operationId: "health",
      tags: ["Bootstrap"],
      responses: { 200: success },
    }),
    (c) => c.json({ ok: true }, 200),
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/bootstrap",
      operationId: "getBootstrap",
      tags: ["Bootstrap"],
      responses: { 200: json(BootstrapPayloadSchema, "Bootstrap state"), 401: error },
    }),
    async (c) => {
      return c.json(readBootstrapPayload(c.get("user").id), 200);
    },
  );

  return route;
}
