import { Hono } from "hono";
import { agentSecretWriteSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { jsonValidator } from "../validation.ts";
import {
  AgentSecretError,
  agentWorkspaceDotEnvStatus,
  deleteAgentSecret,
  importAgentWorkspaceDotEnv,
  readAgentSecrets,
  writeAgentSecret,
} from "../services/agent-secrets.ts";

/**
 * Secrets are addressed under their agent and are write-only over the API:
 * there is no route that returns a value, so a compromised session cookie can
 * rotate a credential but cannot read one back out.
 */
export function createAgentSecretRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();
  route.onError((error, c) => {
    if (error instanceof AgentSecretError) return c.json({ error: error.message }, error.status);
    throw error;
  });

  route.get("/agents/:agentId/secrets", (c) =>
    c.json(readAgentSecrets(c.get("user").id, c.req.param("agentId"))),
  );

  route.get("/agents/:agentId/secrets/import-env", (c) =>
    c.json(agentWorkspaceDotEnvStatus(c.get("user").id, c.req.param("agentId"))),
  );

  route.post("/agents/:agentId/secrets/import-env", (c) =>
    c.json(importAgentWorkspaceDotEnv(c.get("user").id, c.req.param("agentId"))),
  );

  route.put("/agents/:agentId/secrets/:name", jsonValidator(agentSecretWriteSchema), (c) =>
    c.json(
      writeAgentSecret(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("name"),
        c.req.valid("json").value,
      ),
    ),
  );

  route.delete("/agents/:agentId/secrets/:name", (c) => {
    deleteAgentSecret(c.get("user").id, c.req.param("agentId"), c.req.param("name"));
    return c.json({ ok: true });
  });

  return route;
}
