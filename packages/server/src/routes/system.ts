import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { listAvailableGlobalSkills } from "../runtime/resources.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";

export function createSystemRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/health", (c) => c.json({ ok: true }));

  route.get("/bootstrap", (c) => {
    return c.json(readBootstrapPayload(c.get("user").id));
  });

  route.get("/skills/global", (c) => {
    return c.json(
      listAvailableGlobalSkills().map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
      })),
    );
  });

  return route;
}
