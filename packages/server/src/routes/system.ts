import type { ClientToolResultPayload } from "@carmel-agent/shared";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { resolveClientToolResult } from "../runtime/client-tools.ts";
import { listAvailableGlobalSkills } from "../runtime/resources.ts";
import { readBootstrapPayload } from "../services/bootstrap.ts";
import {
  clientToolResultRequestSchema,
  isValidationError,
  jsonValidator,
  validationErrorMessage,
} from "../validation.ts";

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

  route.post("/client-tool-results", jsonValidator(clientToolResultRequestSchema), async (c) => {
    const user = c.get("user");
    try {
      resolveClientToolResult(user.id, c.req.valid("json") as ClientToolResultPayload);
      return c.json({ ok: true });
    } catch (error) {
      if (isValidationError(error)) return c.json({ error: validationErrorMessage(error) }, 400);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return route;
}
