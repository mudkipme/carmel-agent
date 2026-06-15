import {
  DefaultResourceLoader,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agents } from "../db/schema.ts";
import { resolveDataPath } from "../paths.ts";

type AgentRecord = typeof agents.$inferSelect;

export const serverAgentDir = process.env.CARMEL_AGENT_DIR
  ? resolve(process.env.CARMEL_AGENT_DIR)
  : fileURLToPath(new URL("../../../../data/pi-agent", import.meta.url));

export async function createAgentResourceLoader(agent: AgentRecord) {
  const cwd = resolveAgentWorkingDirPath(agent);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: serverAgentDir,
    noExtensions: true,
    noThemes: true,
    systemPromptOverride: () => agent.systemPrompt.trim(),
    appendSystemPromptOverride: () => [],
    skillsOverride: (base) => filterAgentSkills(base, cwd),
  });
  await loader.reload();
  return loader;
}

export function resolveAgentReadableRoots(agent: AgentRecord, cwd = resolveAgentWorkingDirPath(agent)) {
  return [cwd, resolve(cwd, ".agents", "skills")];
}

export function resolveAgentWorkingDirPath(agent: AgentRecord) {
  return resolveDataPath(agent.workingDir || process.cwd());
}

// Only project skills under <workspace>/.agents/skills are loaded. Global skill
// discovery was removed; a future shared-folder or SQLite-backed skill store can
// reintroduce it.
function filterAgentSkills(base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }, cwd: string) {
  const projectSkillRoot = resolve(cwd, ".agents", "skills");
  return {
    skills: base.skills.filter((skill) => isInsidePath(resolve(skill.baseDir), projectSkillRoot)),
    diagnostics: base.diagnostics,
  };
}

function isInsidePath(path: string, root: string) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
