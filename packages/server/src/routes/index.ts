import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { createApiKeyRoutes } from "./api-keys.ts";
import { createAgentSecretRoutes } from "./agent-secrets.ts";
import { createKnowledgeRoutes } from "./knowledge.ts";
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
  api.route("/", createAgentSecretRoutes());
  api.route("/", createKnowledgeRoutes());
  api.route("/", createAgentTaskRoutes());
  api.route("/", createIssueRoutes());
  api.route("/", createAgentRunRoutes());
  api.route("/", createSessionRoutes());

  return api;
}
