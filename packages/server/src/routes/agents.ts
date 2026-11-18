import { BACKGROUND_CONTEXT } from "../effectors/pi-durable/index.ts";
import {
  agentConfigRequestSchema,
  agentMcpServerSchema,
  skillCommandName,
  slashCommandText,
} from "@carmel-agent/shared";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import {
  agentHomes,
  agents,
  environmentSecrets,
  homeMemorySettings,
  sessions,
} from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { AgentExecutionEnv } from "../runtime/execution-env.ts";
import { loadAgentResources, resolveEnvironmentWorkingDirPath } from "../runtime/resources.ts";
import { serializeAgentSettings, serializePublicAgent } from "../serializers.ts";
import { deletePiSessions } from "../services/pi-session-storage.ts";
import {
  readUsableModelRef,
  readVisibleAgent,
  resolveSupportedThinkingLevel,
} from "../services/agent-access.ts";
import { readActiveRunLeaseForAgent } from "../services/active-run-lease.ts";
import { jsonValidator } from "../validation.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";
import {
  deleteEnvironment,
  environmentAgents,
  readAgentEnvironment,
  readEnvironment,
  readOwnedEnvironment,
  releaseUnusedBrowserControl,
  writeEnvironment,
} from "../services/environments.ts";
import { purgeHomeMemoryIndex } from "../services/home-memory-index.ts";
import { deleteAgentKnowledge } from "../services/knowledge.ts";
import { deleteAgentTasksForAgent } from "../services/agent-tasks.ts";
import { deleteIssuesForAgent } from "../services/issues.ts";
import { createAgentFilesRoute } from "./agent-files.ts";
import { createAgentGitRoute } from "./agent-git.ts";
import { AgentMcpTools } from "../runtime/mcp-tools.ts";
import { errorMessage } from "../errors.ts";
import { browserControl } from "../runtime/browser-control.ts";
import { closeEnvironmentBrowsers } from "../runtime/sandbox/browser-sessions.ts";
import { isSandboxConfigured } from "../runtime/sandbox/runtime-client.ts";

export function createAgentRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.put("/agents/:id", jsonValidator(agentConfigRequestSchema), async (c) => {
    const currentUser = c.get("user");
    const currentUserId = currentUser.id;
    const agent = c.req.valid("json");
    const agentId = c.req.param("id");
    const current = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (current && current.ownerUserId !== currentUserId)
      return c.json({ error: "Agent not found." }, 404);
    const activeRun = current ? readActiveRunLeaseForAgent(agentId) : undefined;
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    if (agent.environmentId && !readOwnedEnvironment(currentUserId, agent.environmentId))
      return c.json({ error: "Environment not found." }, 404);
    const defaultModelRef = readUsableModelRef(currentUserId, agent.defaultModelRefId);
    if (!defaultModelRef) {
      return c.json({ error: "Model not found." }, 404);
    }
    const defaultThinkingLevel = resolveSupportedThinkingLevel(
      defaultModelRef,
      agent.defaultThinkingLevel ?? "off",
    );
    const timestamp = now();
    const environmentId = db.transaction(() => {
      // A new agent without a chosen environment gets one of its own.
      const environmentId =
        agent.environmentId ??
        current?.environmentId ??
        writeEnvironment(currentUser, {
          name: agent.name,
          workingDirMode: "default",
          workingDir: "",
          mounts: [],
          network: false,
        }).id;
      db.insert(agents)
        .values({
          ...agent,
          id: agentId,
          ownerUserId: currentUserId,
          environmentId,
          defaultThinkingLevel,
          createdAt: current?.createdAt ?? timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: agents.id,
          set: {
            ownerUserId: currentUserId,
            shared: agent.shared,
            name: agent.name,
            icon: agent.icon ?? current?.icon ?? "bot",
            color: agent.color ?? current?.color ?? null,
            description: agent.description,
            environmentId,
            systemPrompt: agent.systemPrompt,
            promptTemplates: agent.promptTemplates,
            permissions: agent.permissions,
            codemodeEnabled: agent.codemodeEnabled,
            mcpServers: agent.mcpServers,
            defaultModelRefId: agent.defaultModelRefId,
            defaultThinkingLevel,
            updatedAt: timestamp,
          },
        })
        .run();
      // Session credentials follow their session into the new environment.
      if (current && current.environmentId !== environmentId) {
        const agentSessions = db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.agentId, agentId));
        db.update(environmentSecrets)
          .set({ environmentId })
          .where(inArray(environmentSecrets.sessionId, agentSessions))
          .run();
      }
      return environmentId;
    });
    // Browser viewers reach the shared browser through this agent's bash
    // permission. When that or the environment changes, drop them so the next
    // attach is checked against the saved agent.
    if (
      current &&
      (current.environmentId !== environmentId ||
        current.permissions.bash !== agent.permissions.bash)
    ) {
      closeEnvironmentBrowsers(current.environmentId);
      releaseUnusedBrowserControl(current.environmentId);
    }
    // An environment exists for the agents in it: the last one leaving takes it along.
    if (current && current.environmentId !== environmentId) {
      const previous = readEnvironment(current.environmentId);
      if (previous && environmentAgents(previous.id).length === 0)
        await deleteEnvironment(previous);
    }
    return c.json(
      serializePublicAgent(db.select().from(agents).where(eq(agents.id, agentId)).get()!),
    );
  });

  route.delete("/agents/:id", async (c) => {
    const currentUserId = c.get("user").id;
    const agentId = c.req.param("id");
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent || agent.ownerUserId !== currentUserId)
      return c.json({ error: "Agent not found." }, 404);
    const activeRun = readActiveRunLeaseForAgent(agentId);
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    // Tasks first: they reference sessions, and a task left behind would fire
    // against an agent that no longer exists.
    deleteAgentTasksForAgent(agentId);
    deleteIssuesForAgent(agentId);
    await deleteAgentKnowledge(agentId);
    for (const home of db
      .select()
      .from(homeMemorySettings)
      .where(eq(homeMemorySettings.agentId, agentId))
      .all())
      await purgeHomeMemoryIndex(home.userId, agentId);
    const deletedSessions = db.select().from(sessions).where(eq(sessions.agentId, agentId)).all();
    await deletePiSessions(deletedSessions);
    db.delete(agentHomes).where(eq(agentHomes.agentId, agentId)).run();
    db.delete(sessions).where(eq(sessions.agentId, agentId)).run();
    db.delete(agents).where(eq(agents.id, agentId)).run();
    // An environment nobody else uses goes with its agent, as it always has.
    const environment = readAgentEnvironment(agent);
    if (environmentAgents(environment.id).length === 0) await deleteEnvironment(environment);
    else {
      closeEnvironmentBrowsers(environment.id);
      releaseUnusedBrowserControl(environment.id);
    }
    return c.json({ ok: true });
  });

  route.get("/agents/:id/settings", (c) => {
    const agent = db
      .select()
      .from(agents)
      .where(eq(agents.id, c.req.param("id")))
      .get();
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (agent.ownerUserId !== c.get("user").id)
      return c.json({ error: "Agent settings are owner-only." }, 403);
    return c.json(serializeAgentSettings(agent));
  });

  route.post("/agents/:id/mcp/test", jsonValidator(agentMcpServerSchema), async (c) => {
    const agent = db
      .select()
      .from(agents)
      .where(eq(agents.id, c.req.param("id")))
      .get();
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (agent.ownerUserId !== c.get("user").id)
      return c.json({ error: "MCP settings are owner-only." }, 403);
    const activeRun = readActiveRunLeaseForAgent(agent.id);
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    const server = c.req.valid("json");
    if (!agent.permissions[server.transport === "http" ? "network" : "bash"]) {
      return c.json(
        {
          error: `Enable and save ${server.transport === "http" ? "network" : "bash"} permission before testing this server.`,
        },
        403,
      );
    }
    const environment = readAgentEnvironment(agent);
    const mcp = new AgentMcpTools(
      { ...agent, mcpServers: [{ ...server, enabled: true, tools: undefined }] },
      environment,
      resolveEnvironmentWorkingDirPath(environment),
    );
    try {
      await mcp.connect({ signal: c.req.raw.signal });
      return c.json({ tools: mcp.discoveredTools });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    } finally {
      await mcp.close();
    }
  });

  route.get("/agents/:id/commands", async (c) => {
    const userId = c.get("user").id;
    const agent = readVisibleAgent(userId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    const env = new AgentExecutionEnv(agent);
    let resources: Awaited<ReturnType<typeof loadAgentResources>>;
    try {
      resources = await loadAgentResources(agent, env);
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
    const promptCommands = resources.promptTemplates.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      source: "prompt" as const,
      commandText: slashCommandText(prompt.name),
    }));
    const skillCommands = resources.skills.map((skill) => ({
      name: skillCommandName(skill.name),
      description: skill.description,
      source: "skill" as const,
      commandText: slashCommandText(skillCommandName(skill.name)),
      sourcePath: skill.filePath,
    }));
    const agentTemplateCommands = agent.promptTemplates.map((template) => ({
      name: template.name,
      description: template.body,
      source: "prompt" as const,
      commandText: template.body,
    }));
    return c.json({
      commands: [...promptCommands, ...agentTemplateCommands, ...skillCommands].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    });
  });

  route.get("/agents/:id/browser", (c) => {
    const agent = readVisibleAgent(c.get("user").id, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (!agent.permissions.bash)
      return c.json({ error: "Browser access requires bash permission." }, 403);
    return c.json({
      control: browserControl(agent.environmentId).state,
      available: isSandboxConfigured(),
    });
  });

  route.route("/agents", createAgentFilesRoute(readVisibleAgent));
  route.route("/agents", createAgentGitRoute(readVisibleAgent));

  return route;
}
