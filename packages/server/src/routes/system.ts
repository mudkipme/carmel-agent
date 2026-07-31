import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";

export function createSystemRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/health", (c) => c.json({ ok: true }));

  route.get("/bootstrap", async (c) => {
    return c.json(await readBootstrapPayload(c.get("user").id));
  });

  return route;
}
