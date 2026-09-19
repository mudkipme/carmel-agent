import { Hono } from "hono";
import { apiKeyCreateSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { createApiKey, deleteApiKey, readApiKeys } from "../services/api-keys.ts";
import { jsonValidator } from "../validation.ts";

/**
 * Keys for the OpenAI-compatible `/v1` API. Managed only from a signed-in
 * session: a key cannot mint or list other keys, so one leaked key stays one
 * key the owner can revoke here.
 */
export function createApiKeyRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/api-keys", (c) => c.json(readApiKeys(c.get("user").id)));

  route.post("/api-keys", jsonValidator(apiKeyCreateSchema), (c) =>
    c.json(createApiKey(c.get("user").id, c.req.valid("json").name), 201),
  );

  route.delete("/api-keys/:id", (c) => {
    if (!deleteApiKey(c.get("user").id, c.req.param("id"))) return c.json({ error: "API key not found." }, 404);
    return c.json({ ok: true });
  });

  return route;
}
