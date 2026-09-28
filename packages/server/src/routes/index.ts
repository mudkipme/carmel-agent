import { Hono } from "hono";
import { createActivityRoutes } from "./activity.ts";
import type { AuthVariables } from "../auth.ts";
import { createApiKeyRoutes } from "./api-keys.ts";
import { createExtensionRoutes } from "./extensions.ts";
import { createAgentSecretRoutes } from "./agent-secrets.ts";
import { createAgentTaskRoutes } from "./agent-tasks.ts";
import { createIssueRoutes } from "./issues.ts";
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
  api.route("/", createApiKeyRoutes());
  api.route("/", createModelRoutes());
  api.route("/", createProviderConfigRoutes());
  api.route("/", createAgentRoutes());
  api.route("/", createExtensionRoutes());
  api.route("/", createAgentSecretRoutes());
  api.route("/", createAgentTaskRoutes());
  api.route("/", createIssueRoutes());
  api.route("/", createActivityRoutes());
  api.route("/", createAgentRunRoutes());
  api.route("/", createSessionRoutes());

  return api;
}
