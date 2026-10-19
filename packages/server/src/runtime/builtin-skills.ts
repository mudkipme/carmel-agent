import {
  BACKGROUND_CONTEXT,
  formatSkillInvocation,
  loadSkills,
  type ToolRegistration,
  type Skill,
} from "../effectors/pi-durable/index.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fileURLToPath } from "node:url";
import type { AgentPermissions } from "@carmel-agent/shared";
import { knowledgeEnabled } from "../services/knowledge.ts";
import { readVisibleAgent } from "../services/agent-access.ts";

const directory = fileURLToPath(new URL("../../skills/", import.meta.url));
type AgentCapabilities = { id: string; permissions: AgentPermissions };
const registry = [
  { name: "agent-browser", available: hasBrowserSkill },
  { name: "knowledge-search", available: hasKnowledgeSkill },
].map((entry) => ({
  ...entry,
  filePath: fileURLToPath(new URL(`../../skills/${entry.name}/SKILL.md`, import.meta.url)),
}));
let bundled: Promise<Skill[]> | undefined;

export function hasBrowserSkill(agent: AgentCapabilities) {
  return agent.permissions.bash && agent.permissions.network;
}

function hasKnowledgeSkill(agent: AgentCapabilities) {
  return agent.permissions.read && knowledgeEnabled(agent.id);
}

export function availableBuiltinSkillNames(agent: AgentCapabilities) {
  return registry.filter((entry) => entry.available(agent)).map((entry) => entry.name);
}

/** Application-owned resources, never discovered through a user-controlled path. */
export async function loadBuiltinSkills(agent: AgentCapabilities): Promise<Skill[]> {
  const names = new Set(availableBuiltinSkillNames(agent));
  if (!names.size) return [];
  bundled ??= (async () => {
    const env = new NodeExecutionEnv({ cwd: directory });
    try {
      const result = await loadSkills(env, directory, BACKGROUND_CONTEXT);
      if (
        result.diagnostics.length ||
        result.skills.length !== registry.length ||
        registry.some(
          (entry) =>
            !result.skills.some(
              (skill) => skill.name === entry.name && skill.filePath === entry.filePath,
            ),
        )
      ) {
        throw new Error("A bundled built-in skill is missing or invalid.");
      }
      return result.skills;
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  })();
  return (await bundled)
    .filter((skill) => names.has(skill.name))
    .map((skill) => ({ ...skill, source: "builtin" }));
}

export function isBuiltinSkill(skill: Skill) {
  return registry.some((entry) => skill.name === entry.name && skill.filePath === entry.filePath);
}

export function formatBuiltinSkillsForSystemPrompt(skills: Skill[]) {
  const builtins = skills.filter(isBuiltinSkill);
  if (!builtins.length) return "";
  return (
    "Built-in skills: before doing a matching task, call load_builtin_skill with its name to load the guide. These are application resources; do not try to read their server paths through bash or workspace file tools.\n" +
    builtins.map(({ name, description }) => JSON.stringify({ name, description })).join("\n")
  );
}

/** Bounded resource access also works when workspace read permission is disabled. */
export function builtinSkillTool(agent: AgentCapabilities, userId?: string): ToolRegistration {
  const names = availableBuiltinSkillNames(agent);
  return {
    name: "load_builtin_skill",
    replay: "safe",
    description: `Load a built-in skill's instructions by name before using its workflow. Available skills: ${names.join(", ")}.`,
    parameters: {
      type: "object",
      properties: { name: { type: "string", enum: names } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(args, _api, context) {
      context.abortSignal?.throwIfAborted();
      const name = (args as { name: string }).name;
      // Knowledge follows source visibility; browser guides also serve admin-owned tasks.
      const currentAgent =
        name === "knowledge-search" && userId ? readVisibleAgent(userId, agent.id) : agent;
      if (!currentAgent) throw new Error("Built-in skill is unavailable for this agent.");
      const skill = (await loadBuiltinSkills(currentAgent)).find((skill) => skill.name === name);
      if (!skill) throw new Error("Built-in skill is unavailable for this agent.");
      return { output: [{ type: "text", text: formatSkillInvocation(skill) }], details: {} };
    },
  };
}
