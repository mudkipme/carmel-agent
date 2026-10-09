import { Hono } from "hono";
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
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/:id/git/status", async (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    const refusal = refuse(agent);
    if (refusal) return c.json({ error: refusal.error }, refusal.status);
    try {
      return c.json(await readGitStatus(agent));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });

  route.get("/:id/git/diff", async (c) => {
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
        await readGitFileDiff(agent, env, {
          path,
          area,
          originalPath: c.req.query("originalPath") || undefined,
        }),
      );
    } catch (error) {
      return c.json({ error: errorMessage(error) }, isGitRequestError(error) ? 400 : 502);
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
    }
  });

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
