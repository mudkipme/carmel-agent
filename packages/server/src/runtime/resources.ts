import {
  loadPromptTemplates,
  loadSkills,
  type ExecutionEnv,
  type PromptTemplate,
  type PromptTemplateDiagnostic,
  type Skill,
  type SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import { resolve } from "node:path";
import { agents } from "../db/schema.ts";
import { resolveDataPath } from "../paths.ts";

type AgentRecord = typeof agents.$inferSelect;
type ContextFile = { path: string; content: string };
type ContextDiagnostic = {
  type: "warning";
  code: "file_info_failed" | "read_failed";
  message: string;
  path: string;
};

export type AgentResources = {
  skills: Skill[];
  promptTemplates: PromptTemplate[];
  contextFiles: ContextFile[];
  diagnostics: Array<SkillDiagnostic | PromptTemplateDiagnostic | ContextDiagnostic>;
};

/** Load every filesystem-backed resource through the agent's execution authority. */
export async function loadAgentResources(agent: AgentRecord, env: ExecutionEnv): Promise<AgentResources> {
  const cwd = resolveAgentWorkingDirPath(agent);
  const [skillResult, promptResult, contextResult] = await Promise.all([
    loadSkills(env, resolve(cwd, ".agents", "skills")),
    loadPromptTemplates(env, resolve(cwd, ".pi", "prompts")),
    loadWorkspaceContext(env, cwd),
  ]);
  return {
    skills: skillResult.skills,
    promptTemplates: promptResult.promptTemplates,
    contextFiles: contextResult.contextFiles,
    diagnostics: [...skillResult.diagnostics, ...promptResult.diagnostics, ...contextResult.diagnostics],
  };
}

export function resolveAgentWorkingDirPath(agent: AgentRecord) {
  return resolveDataPath(agent.workingDir || process.cwd());
}

async function loadWorkspaceContext(
  env: ExecutionEnv,
  cwd: string,
): Promise<{ contextFiles: ContextFile[]; diagnostics: ContextDiagnostic[] }> {
  const diagnostics: ContextDiagnostic[] = [];
  for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const path = resolve(cwd, name);
    const info = await env.fileInfo(path);
    if (!info.ok) {
      if (info.error.code !== "not_found") {
        diagnostics.push({ type: "warning", code: "file_info_failed", message: info.error.message, path });
      }
      continue;
    }
    const content = await env.readTextFile(path);
    if (!content.ok) {
      diagnostics.push({ type: "warning", code: "read_failed", message: content.error.message, path });
      continue;
    }
    return { contextFiles: [{ path, content: content.value }], diagnostics };
  }
  return { contextFiles: [], diagnostics };
}
