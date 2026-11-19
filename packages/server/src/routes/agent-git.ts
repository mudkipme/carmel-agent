import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createRouter, error, json } from "../openapi/routes.ts";
import { GitFileDiffSchema, GitStatusSchema } from "../openapi/schemas.ts";
import type { GitChangeArea } from "@carmel-agent/shared";
import { BACKGROUND_CONTEXT } from "../effectors/pi-durable/index.ts";
import type { AuthVariables } from "../auth.ts";
import type { agents } from "../db/schema.ts";
import { errorMessage } from "../errors.ts";
import { AgentExecutionEnv } from "../runtime/execution-env.ts";
import { isGitRequestError, readGitFileDiff, readGitStatus } from "../runtime/git-workspace.ts";
import { isSandboxConfigured } from "../runtime/sandbox/runtime-client.ts";

type AgentRecord = typeof agents.$inferSelect;
type ReadVisibleAgent = (userId: string, agentId: string) => AgentRecord | undefined;

const AREAS: readonly GitChangeArea[] = ["staged", "unstaged", "untracked", "conflicted"];

/**
 * The Changes view: working-tree status and per-file diffs, read-only.
 *
 * Gated like the file browser -- a visible agent with read permission -- but
 * served from the agent's sandbox, so it needs the container runtime even for
 * an agent that has no bash permission. See `runtime/git-workspace.ts`.
 */
export function createAgentGitRoute(readVisibleAgent: ReadVisibleAgent) {
  const route = createRouter<{ Variables: AuthVariables }>();

  route.openapi(
    createRoute({
      method: "get",
      path: "/{id}/git/status",
      operationId: "getAgentGitStatus",
      tags: ["Files"],
      description:
        "Read-only working-tree status of the repository containing the agent's working directory. Runs git in the agent's sandbox.",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        404: error,
        200: json(GitStatusSchema, "Status"),
        403: error,
        502: error,
        503: error,
      },
    }),
    async (c) => {
      const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
      if (!agent) return c.json({ error: "Agent not found." }, 404);
      const refusal = refuse(agent);
      if (refusal) return c.json({ error: refusal.error }, refusal.status);
      const env = new AgentExecutionEnv(agent);
      try {
        return c.json(await readGitStatus(env), 200);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 502);
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
      }
    },
  );

  route.openapi(
    createRoute({
      method: "get",
      path: "/{id}/git/diff",
      operationId: "getAgentGitDiff",
      tags: ["Files"],
      parameters: [
        { name: "path", in: "query", required: true, schema: { type: "string" } },
        {
          name: "area",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["staged", "unstaged", "untracked", "conflicted"] },
        },
        { name: "originalPath", in: "query", schema: { type: "string" } },
      ],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        404: error,
        200: json(GitFileDiffSchema, "Both sides of one file's change"),
        400: error,
        403: error,
        502: error,
        503: error,
      },
    }),
    async (c) => {
      const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
      if (!agent) return c.json({ error: "Agent not found." }, 404);
      const refusal = refuse(agent);
      if (refusal) return c.json({ error: refusal.error }, refusal.status);
      const path = c.req.query("path");
      const area = c.req.query("area") as GitChangeArea | undefined;
      if (!path || !area || !AREAS.includes(area))
        return c.json({ error: "path and area are required." }, 400);

      const env = new AgentExecutionEnv(agent);
      try {
        return c.json(
          await readGitFileDiff(env, {
            path,
            area,
            originalPath: c.req.query("originalPath") || undefined,
          }),
          200,
        );
      } catch (error) {
        return c.json({ error: errorMessage(error) }, isGitRequestError(error) ? 400 : 502);
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
      }
    },
  );

  return route;
}

function refuse(agent: AgentRecord): { error: string; status: 403 | 503 } | undefined {
  if (!agent.permissions.read)
    return { error: "Read permission is disabled for this agent.", status: 403 };
  if (!isSandboxConfigured()) {
    return {
      error:
        "Changes are read with git inside the agent's sandbox, and no container runtime is reachable. " +
        "An administrator can start the rootless Podman socket or set CARMEL_PODMAN_SOCKET.",
      status: 503,
    };
  }
  return undefined;
}
