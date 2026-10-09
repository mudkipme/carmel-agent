import {
  BACKGROUND_CONTEXT,
  loadPromptTemplates,
  loadSkills,
  type ExecutionEnv,
  type PromptTemplate,
  type PromptTemplateDiagnostic,
  type Skill,
  type SkillDiagnostic,
} from "../effectors/pi-durable/index.ts";
import { resolve } from "node:path";
import { agents } from "../db/schema.ts";
import { resolveDataPath } from "../paths.ts";
import { loadBuiltinSkills } from "./builtin-skills.ts";

type AgentRecord = typeof agents.$inferSelect;

/** Resource loading runs once at session open and was never cancellable. */
const ctx = BACKGROUND_CONTEXT;
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

/** Workspace resources use agent authority; built-ins come from the application bundle. */
export async function loadAgentResources(
  agent: AgentRecord,
  env: ExecutionEnv,
): Promise<AgentResources> {
  const cwd = env.cwd;
  const [skillResult, promptResult, contextResult, builtins] = await Promise.all([
    loadSkills(env, resolve(cwd, ".agents", "skills"), ctx),
    loadPromptTemplates(env, resolve(cwd, ".pi", "prompts"), ctx),
    loadWorkspaceContext(env, cwd),
    loadBuiltinSkills(agent),
  ]);
  return {
    // Sorted, because both of these reach the system prompt and Pi discovers
    // them with `readdirSync` and no ordering of its own. Directory order is
    // usually stable on one filesystem, but nothing promises it -- and an order
    // that shifts silently invalidates the cached prompt prefix for the whole
    // session, which costs far more than the sort.
    // Carmel's workflow wins a name collision with a workspace copy of upstream.
    skills: sortByName([
      ...skillResult.skills.filter(
        (skill) => !builtins.some((builtin) => builtin.name === skill.name),
      ),
      ...builtins,
    ]),
    promptTemplates: sortByName(promptResult.promptTemplates),
    contextFiles: contextResult.contextFiles,
    diagnostics: [
      ...skillResult.diagnostics,
      ...promptResult.diagnostics,
      ...contextResult.diagnostics,
    ],
  };
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
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
    const info = await env.fileInfo(path, ctx);
    if (!info.ok) {
      if (info.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: info.error.message,
          path,
        });
      }
      continue;
    }
    const content = await env.readTextFile(path, ctx);
    if (!content.ok) {
      diagnostics.push({
        type: "warning",
        code: "read_failed",
        message: content.error.message,
        path,
      });
      continue;
    }
    return { contextFiles: [{ path, content: content.value }], diagnostics };
  }
  return { contextFiles: [], diagnostics };
}
