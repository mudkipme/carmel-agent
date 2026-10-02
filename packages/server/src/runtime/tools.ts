import type { AgentHarnessTool, Context, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { agents } from "../db/schema.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import { builtinToolProviders } from "./tool-providers/index.ts";
import { AgentMcpTools } from "./mcp-tools.ts";
import { createCodemodeTool, type CodemodeHooks } from "./codemode-tool.ts";
import { browserHelpTool, guardBrowserHandoff } from "./browser-tools.ts";
import { browserControl } from "./browser-control.ts";
import { builtinSkillTool, hasBrowserSkill } from "./builtin-skills.ts";
import {
  collectAgentTools,
  type ToolProvider,
  type ToolProvisionContext,
} from "../effectors/contracts/tool-provider.ts";
export { remapContainerPath } from "./execution-env.ts";

type AgentRecord = typeof agents.$inferSelect;

export function createServerExecution(agent: AgentRecord, codemodeHooks?: CodemodeHooks) {
  const browserRevision = { revision: agent.permissions.bash ? browserControl(agent.id).state.revision : 0 };
  const env = new AgentExecutionEnv(agent);
  const mcp = new AgentMcpTools(agent, env.cwd);
  const tools = createServerToolDefinitions(agent, env);
  return {
    env,
    toolContext: { env } satisfies ExecutionToolContext,
    tools,
    async prepare(signal?: AbortSignal) {
      await mcp.connect({ signal });
      tools.push(...mcp.tools);
    },
    /** Compose session overrides before exposing the same tool set to codemode. */
    resolveTools(sessionTools: readonly AgentHarnessTool<ExecutionToolContext>[] = []) {
      const overrides = new Set(sessionTools.map((tool) => tool.name));
      const available = [...tools.filter((tool) => !overrides.has(tool.name)), ...sessionTools]
        .filter((tool) => tool.name !== "codemode" && tool.name !== "load_builtin_skill");
      if (hasBrowserSkill(agent)) available.push(builtinSkillTool(agent));
      const composed = agent.codemodeEnabled ? [...available, createCodemodeTool(available, codemodeHooks)] : available;
      // Gate the entire codemode batch so its deadline starts after human control ends.
      return agent.permissions.bash
        ? [...composed.map((tool) => guardBrowserHandoff(agent.id, tool, browserRevision)), browserHelpTool(agent)]
        : composed;
    },
    async cleanup(context: Context) {
      try { await mcp.close(); } finally { await env.cleanup(context); }
    },
  };
}

/**
 * Build one agent's tool list, filtered by its capability permissions.
 */
export function createServerToolDefinitions(
  agent: AgentRecord,
  env = new AgentExecutionEnv(agent),
  providers: readonly ToolProvider[] = builtinToolProviders,
): AgentHarnessTool<ExecutionToolContext>[] {
  const context: ToolProvisionContext = {
    agentId: agent.id,
    workingDir: env.cwd,
    permissions: agent.permissions,
    env,
  };
  return collectAgentTools(providers, context).tools;
}
