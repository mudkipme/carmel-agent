import type { AgentConfig } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { agents, modelRefs, sessions } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { createAgentResourceLoader } from "../runtime/resources.ts";
import { discardAgentContainer } from "../runtime/sandbox/container-manager.ts";
import { serializeAgentSettings, serializePublicAgent } from "../serializers.ts";
import {
  AgentHostPathAccessError,
  assertAgentHostPathAccess,
  canUseModel,
  readVisibleAgent,
  resolveAgentWorkingDir,
  resolveSupportedThinkingLevel,
} from "../services/agent-access.ts";
import { agentConfigRequestSchema, jsonValidator } from "../validation.ts";
import { createAgentFilesRoute } from "./agent-files.ts";

export function createAgentRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.put("/agents/:id", jsonValidator(agentConfigRequestSchema), async (c) => {
    const currentUser = c.get("user");
    const currentUserId = currentUser.id;
    const agent = c.req.valid("json") as AgentConfig;
    const agentId = c.req.param("id");
    const current = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (current && current.ownerUserId !== currentUserId) return c.json({ error: "Agent not found." }, 404);
    try {
      assertAgentHostPathAccess(currentUser.role, agent);
    } catch (error) {
      if (error instanceof AgentHostPathAccessError) return c.json({ error: error.message }, 403);
      throw error;
    }
    const defaultModelRef = db.select().from(modelRefs).where(eq(modelRefs.id, agent.defaultModelRefId)).get();
    if (!defaultModelRef || !canUseModel(currentUserId, defaultModelRef)) {
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
        createdAt: agent.createdAt ?? timestamp,
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
          defaultModelRefId: agent.defaultModelRefId,
          defaultThinkingLevel,
          updatedAt: timestamp,
        },
      })
      .run();
    return c.json(serializePublicAgent(db.select().from(agents).where(eq(agents.id, agentId)).get()!));
  });

  route.delete("/agents/:id", (c) => {
    const currentUserId = c.get("user").id;
    const agentId = c.req.param("id");
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent || agent.ownerUserId !== currentUserId) return c.json({ error: "Agent not found." }, 404);
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

  route.get("/agents/:id/commands", async (c) => {
    const userId = c.get("user").id;
    const agent = readVisibleAgent(userId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const resourceLoader = await createAgentResourceLoader(agent);
    const { skills } = resourceLoader.getSkills();
    const { prompts } = resourceLoader.getPrompts();
    const promptCommands = prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      source: "prompt" as const,
      commandText: `/${prompt.name} `,
      sourcePath: prompt.filePath,
      argumentHint: prompt.argumentHint,
    }));
    const skillCommands = skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      commandText: `/skill:${skill.name} `,
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

  route.route("/agents", createAgentFilesRoute(readVisibleAgent));

  return route;
}
