import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { createExtensionRoutes } from "./extensions.ts";
import { createAgentTaskRoutes } from "./agent-tasks.ts";
import { createAgentRoutes } from "./agents.ts";
import { createAgentRunRoutes } from "./agent-runs.ts";
import { createAuthRoutes } from "./auth.ts";
import { createModelRoutes } from "./models.ts";
import { createProviderConfigRoutes } from "./provider-configs.ts";
import { createSessionRoutes } from "./sessions.ts";
import { createSystemRoutes } from "./system.ts";
import { createUserRoutes } from "./users.ts";

export function createApiRoutes() {
  const api = new Hono<{ Variables: AuthVariables }>();

  api.route("/", createSystemRoutes());
  api.route("/auth", createAuthRoutes());
  api.route("/", createUserRoutes());
  api.route("/", createModelRoutes());
  api.route("/", createProviderConfigRoutes());
  api.route("/", createAgentRoutes());
  api.route("/", createExtensionRoutes());
  api.route("/", createAgentTaskRoutes());
  api.route("/", createAgentRunRoutes());
  api.route("/", createSessionRoutes());

  return api;
}
