import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { agentConfigRequestSchema, agentMcpServerSchema, skillCommandName, slashCommandText } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { agents, sessions } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { AgentExecutionEnv } from "../runtime/execution-env.ts";
import { loadAgentResources, resolveAgentWorkingDirPath } from "../runtime/resources.ts";
import { discardAgentContainer } from "../runtime/sandbox/container-manager.ts";
import { closeAgentTerminals } from "../runtime/sandbox/terminal-sessions.ts";
import { serializeAgentSettings, serializePublicAgent } from "../serializers.ts";
import { deletePiSessions } from "../services/pi-session-storage.ts";
import {
  AgentHostPathAccessError,
  assertAgentHostPathAccess,
  readUsableModelRef,
  readVisibleAgent,
  resolveAgentWorkingDir,
  resolveSupportedThinkingLevel,
} from "../services/agent-access.ts";
import { readActiveRunLeaseForAgent } from "../services/active-run-lease.ts";
import { jsonValidator } from "../validation.ts";
import { activeRunConflictResponse } from "./active-run-conflict.ts";
import { deleteAgentSecretsForAgent } from "../services/agent-secrets.ts";
import { deleteAgentTasksForAgent } from "../services/agent-tasks.ts";
import { deleteIssuesForAgent } from "../services/issues.ts";
import { createAgentFilesRoute } from "./agent-files.ts";
import { createAgentGitRoute } from "./agent-git.ts";
import { AgentMcpTools } from "../runtime/mcp-tools.ts";
import { errorMessage } from "../errors.ts";
import { browserControl, deleteBrowserControl } from "../runtime/browser-control.ts";
import { closeAgentBrowsers } from "../runtime/sandbox/browser-sessions.ts";
import { isSandboxConfigured } from "../runtime/sandbox/podman.ts";

export function createAgentRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.put("/agents/:id", jsonValidator(agentConfigRequestSchema), async (c) => {
    const currentUser = c.get("user");
    const currentUserId = currentUser.id;
    const agent = c.req.valid("json");
    const agentId = c.req.param("id");
    const current = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (current && current.ownerUserId !== currentUserId) return c.json({ error: "Agent not found." }, 404);
    const activeRun = current ? readActiveRunLeaseForAgent(agentId) : undefined;
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    try {
      assertAgentHostPathAccess(currentUser.role, agent);
    } catch (error) {
      if (error instanceof AgentHostPathAccessError) return c.json({ error: error.message }, 403);
      throw error;
    }
    const defaultModelRef = readUsableModelRef(currentUserId, agent.defaultModelRefId);
    if (!defaultModelRef) {
      return c.json({ error: "Model not found." }, 404);
    }
    const defaultThinkingLevel = resolveSupportedThinkingLevel(defaultModelRef, agent.defaultThinkingLevel ?? "off");
    const workingDir = resolveAgentWorkingDir(agent, agentId, current);
    if (!workingDir) return c.json({ error: "Manual working directory is required." }, 400);
    const timestamp = now();
    db.insert(agents)
      .values({
        ...agent,
        id: agentId,
        ownerUserId: currentUserId,
        workingDirMode: agent.workingDirMode ?? "default",
        workingDir: workingDir.workingDir,
        defaultWorkingDir: workingDir.defaultWorkingDir,
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
          description: agent.description,
          workingDirMode: agent.workingDirMode ?? "default",
          workingDir: workingDir.workingDir,
          defaultWorkingDir: workingDir.defaultWorkingDir,
          mounts: agent.mounts,
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
    // Permissions, mounts, and the working directory are all baked into a live
    // shell. Rather than leave one running against the old configuration, close
    // it and let the next attach start from the saved agent.
    closeAgentTerminals(agentId, "The agent settings changed.");
    closeAgentBrowsers(agentId);
    if (!agent.permissions.bash) deleteBrowserControl(agentId);
    return c.json(serializePublicAgent(db.select().from(agents).where(eq(agents.id, agentId)).get()!));
  });

  route.delete("/agents/:id", async (c) => {
    const currentUserId = c.get("user").id;
    const agentId = c.req.param("id");
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent || agent.ownerUserId !== currentUserId) return c.json({ error: "Agent not found." }, 404);
    const activeRun = readActiveRunLeaseForAgent(agentId);
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    // Tasks first: they reference sessions, and a task left behind would fire
    // against an agent that no longer exists.
    closeAgentTerminals(agentId, "The agent was deleted.");
    closeAgentBrowsers(agentId);
    deleteBrowserControl(agentId);
    deleteAgentTasksForAgent(agentId);
    deleteIssuesForAgent(agentId);
    deleteAgentSecretsForAgent(agentId);
    const deletedSessions = db.select().from(sessions).where(eq(sessions.agentId, agentId)).all();
    await deletePiSessions(deletedSessions);
    db.delete(sessions).where(eq(sessions.agentId, agentId)).run();
    db.delete(agents).where(eq(agents.id, agentId)).run();
    void discardAgentContainer(agentId);
    return c.json({ ok: true });
  });

  route.get("/agents/:id/settings", (c) => {
    const agent = db.select().from(agents).where(eq(agents.id, c.req.param("id"))).get();
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    if (agent.ownerUserId !== c.get("user").id) return c.json({ error: "Agent settings are owner-only." }, 403);
    return c.json(serializeAgentSettings(agent));
  });

  route.post("/agents/:id/mcp/test", jsonValidator(agentMcpServerSchema), async (c) => {
    const agent = db.select().from(agents).where(eq(agents.id, c.req.param("id"))).get();
    if (!agent) return c.json({ error: "Agent not found." }, 404);
    if (agent.ownerUserId !== c.get("user").id) return c.json({ error: "MCP settings are owner-only." }, 403);
    const activeRun = readActiveRunLeaseForAgent(agent.id);
    if (activeRun) return activeRunConflictResponse(c, activeRun);
    const server = c.req.valid("json");
    if (!agent.permissions[server.transport === "http" ? "network" : "bash"]) {
      return c.json({ error: `Enable and save ${server.transport === "http" ? "network" : "bash"} permission before testing this server.` }, 403);
    }
    const mcp = new AgentMcpTools({ ...agent, mcpServers: [{ ...server, enabled: true, tools: undefined }] }, resolveAgentWorkingDirPath(agent));
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
    if (!agent) return c.json({ error: "Agent not found" }, 404);
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
    if (!agent.permissions.bash) return c.json({ error: "Browser access requires bash permission." }, 403);
    return c.json({ control: browserControl(agent.id).state, available: isSandboxConfigured() });
  });

  route.route("/agents", createAgentFilesRoute(readVisibleAgent));
  route.route("/agents", createAgentGitRoute(readVisibleAgent));

  return route;
}
