import { environmentRequestSchema } from "@carmel-agent/shared";
import { Hono } from "hono";
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
import { jsonValidator } from "../validation.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";

export function createEnvironmentRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof EnvironmentError) return c.json({ error: error.message }, error.status);
    throw error;
  });

  route.get("/environments", (c) =>
    c.json(readOwnedEnvironments(c.get("user").id).map(serializeEnvironment)),
  );

  route.post("/environments", jsonValidator(environmentRequestSchema), (c) =>
    c.json(serializeEnvironment(writeEnvironment(c.get("user"), c.req.valid("json")))),
  );

  route.put("/environments/:id", jsonValidator(environmentRequestSchema), (c) => {
    const user = c.get("user");
    const current = readOwnedEnvironment(user.id, c.req.param("id"));
    if (!current) return c.json({ error: "Environment not found." }, 404);
    const activeRun = readActiveRunLeaseForEnvironment(current.id);
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    const environment = writeEnvironment(user, c.req.valid("json"), current);
    closeEnvironmentSessions(environment.id, "The environment settings changed.");
    return c.json(serializeEnvironment(environment));
  });

  route.delete("/environments/:id", async (c) => {
    const environment = readOwnedEnvironment(c.get("user").id, c.req.param("id"));
    if (!environment) return c.json({ error: "Environment not found." }, 404);
    await deleteEnvironment(environment);
    return c.json({ ok: true });
  });

  return route;
}
