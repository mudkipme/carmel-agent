import {
  BACKGROUND_CONTEXT,
  formatSkillInvocation,
  loadSkills,
  type AgentHarnessTool,
  type ExecutionToolContext,
  type Skill,
} from "../effectors/pi-durable/index.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fileURLToPath } from "node:url";
import type { AgentPermissions } from "@carmel-agent/shared";

const directory = fileURLToPath(new URL("../../skills/", import.meta.url));
const browserSkillPath = fileURLToPath(
  new URL("../../skills/agent-browser/SKILL.md", import.meta.url),
);
type AgentCapabilities = { permissions: AgentPermissions };
let bundled: Promise<Skill[]> | undefined;

export function hasBrowserSkill(agent: AgentCapabilities) {
  return agent.permissions.bash && agent.permissions.network;
}

/** Application-owned resources, never discovered through a user-controlled path. */
export async function loadBuiltinSkills(agent: AgentCapabilities): Promise<Skill[]> {
  if (!hasBrowserSkill(agent)) return [];
  bundled ??= (async () => {
    const env = new NodeExecutionEnv({ cwd: directory });
    try {
      const result = await loadSkills(env, directory, BACKGROUND_CONTEXT);
      if (
        result.diagnostics.length ||
        result.skills.length !== 1 ||
        result.skills[0]?.name !== "agent-browser"
      ) {
        throw new Error("The bundled agent-browser skill is missing or invalid.");
      }
      return result.skills;
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  })();
  return (await bundled).map((skill) => ({ ...skill, source: "builtin" }));
}

export function isBuiltinSkill(skill: Skill) {
  return skill.filePath === browserSkillPath;
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
export function builtinSkillTool(agent: AgentCapabilities): AgentHarnessTool<ExecutionToolContext> {
  return {
    name: "load_builtin_skill",
    replay: "safe",
    label: "Load built-in skill",
    description:
      "Load a built-in skill's instructions by name before using its workflow. Available skill: agent-browser (Carmel browser automation and human sign-in handoff).",
    parameters: {
      type: "object",
      properties: { name: { type: "string", enum: ["agent-browser"] } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(_id, args, _update, _tools, _invocation, context) {
      context.abortSignal?.throwIfAborted();
      const skill = (await loadBuiltinSkills(agent)).find(
        (skill) => skill.name === (args as { name: string }).name,
      );
      if (!skill) throw new Error("Built-in skill is unavailable for this agent.");
      return { content: [{ type: "text", text: formatSkillInvocation(skill) }], details: {} };
    },
  };
}
