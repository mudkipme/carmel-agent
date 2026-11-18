import { Hono } from "hono";
import { agentSecretWriteSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { jsonValidator } from "../validation.ts";
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
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof SecretError) return c.json({ error: error.message }, error.status);
    throw error;
  });

  route.get("/environments/:environmentId/secrets", (c) =>
    c.json(readEnvironmentSecrets(c.get("user").id, c.req.param("environmentId"))),
  );

  route.get("/environments/:environmentId/secrets/import-env", (c) =>
    c.json(
      environmentWorkspaceDotEnvStatus(
        c.get("user").id,
        c.req.param("environmentId"),
        c.req.query("agent") ?? "",
      ),
    ),
  );

  route.post("/environments/:environmentId/secrets/import-env", (c) =>
    c.json(
      importEnvironmentWorkspaceDotEnv(
        c.get("user").id,
        c.req.param("environmentId"),
        c.req.query("agent") ?? "",
      ),
    ),
  );

  route.put(
    "/environments/:environmentId/secrets/:name",
    jsonValidator(agentSecretWriteSchema),
    (c) =>
      c.json(
        writeEnvironmentSecret(
          c.get("user").id,
          c.req.param("environmentId"),
          c.req.param("name"),
          c.req.valid("json").value,
        ),
      ),
  );

  route.delete("/environments/:environmentId/secrets/:name", (c) => {
    deleteEnvironmentSecret(c.get("user").id, c.req.param("environmentId"), c.req.param("name"));
    return c.json({ ok: true });
  });

  return route;
}
