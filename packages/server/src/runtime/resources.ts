import {
  DefaultResourceLoader,
  loadSkillsFromDir,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
    skillsOverride: (base) => filterAgentSkills(base, agent, cwd),
  });
  await loader.reload();
  return loader;
}

export function resolveAgentReadableRoots(agent: AgentRecord, cwd = resolveAgentWorkingDirPath(agent)) {
  return [cwd, resolve(cwd, ".agents", "skills"), ...resolveGlobalSkillPaths(agent.skills)].map((path) =>
    resolve(expandHomePath(path)),
  );
}

export function listAvailableGlobalSkills() {
  const skillsByName = new Map<string, Skill>();
  for (const dir of getGlobalSkillDirs()) {
    const { skills } = loadSkillsFromDir({ dir, source: "user" });
    for (const skill of skills) {
      if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
    }
  }
  return [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveAgentWorkingDirPath(agent: AgentRecord) {
  return resolveDataPath(agent.workingDir || process.cwd());
}

function filterAgentSkills(base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }, agent: AgentRecord, cwd: string) {
  const selectedGlobalSkillDirs = new Set(resolveGlobalSkillPaths(agent.skills).map((path) => resolve(expandHomePath(path))));
  const projectSkillRoot = resolve(cwd, ".agents", "skills");

  return {
    skills: base.skills.filter((skill) => {
      const skillBaseDir = resolve(skill.baseDir);
      if (isInsidePath(skillBaseDir, projectSkillRoot)) return true;
      return selectedGlobalSkillDirs.has(skillBaseDir);
    }),
    diagnostics: base.diagnostics,
  };
}

function resolveGlobalSkillPaths(skillNames: string[]) {
  const globalSkillDirs = getGlobalSkillDirs();

  return skillNames.map((skillName) => {
    if (isPathLike(skillName)) return skillName;
    const matchingDir = globalSkillDirs.find((dir) => existsSync(join(dir, skillName, "SKILL.md")));
    return matchingDir ? join(matchingDir, skillName) : join(globalSkillDirs[0], skillName);
  });
}

function getGlobalSkillDirs() {
  return [
    process.env.CARMEL_GLOBAL_SKILLS_DIR,
    join(homedir(), ".agent", "skills"),
    join(homedir(), ".agents", "skills"),
    join(serverAgentDir, "skills"),
  ].filter((path): path is string => Boolean(path)).map((path) => resolve(expandHomePath(path)));
}

function isPathLike(value: string) {
  return value.startsWith(".") || value.startsWith("/") || value.startsWith("~") || value.includes("/") || value.includes("\\");
}

function expandHomePath(path: string) {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function isInsidePath(path: string, root: string) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}
