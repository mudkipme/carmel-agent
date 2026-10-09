import { Hono } from "hono";
import { agentSecretWriteSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { jsonValidator } from "../validation.ts";
import {
  AgentSecretError,
  deleteAgentSecret,
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

  route.get("/agents/:agentId/secrets", (c) =>
    respond(c, () => readAgentSecrets(c.get("user").id, c.req.param("agentId"))),
  );

  route.put("/agents/:agentId/secrets/:name", jsonValidator(agentSecretWriteSchema), (c) =>
    respond(c, () =>
      writeAgentSecret(
        c.get("user").id,
        c.req.param("agentId"),
        c.req.param("name"),
        c.req.valid("json").value,
      ),
    ),
  );

  route.delete("/agents/:agentId/secrets/:name", (c) =>
    respond(c, () => {
      deleteAgentSecret(c.get("user").id, c.req.param("agentId"), c.req.param("name"));
      return { ok: true } as const;
    }),
  );

  return route;
}

function respond<T>(
  c: { json: (body: unknown, status?: 200 | 400 | 403 | 404) => Response },
  read: () => T,
) {
  try {
    return c.json(read() as object);
  } catch (error) {
    if (error instanceof AgentSecretError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}
