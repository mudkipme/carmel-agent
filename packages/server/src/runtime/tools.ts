import type { ToolRegistration, Context } from "../effectors/pi-durable/index.ts";
import { agents } from "../db/schema.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import { builtinToolProviders } from "./tool-providers/index.ts";
import { AgentMcpTools } from "./mcp-tools.ts";
import { createCarmelCodemode, type CodemodeHooks } from "./codemode-tool.ts";
import { browserHelpTool, guardBrowserHandoff } from "./browser-tools.ts";
import { browserControl } from "./browser-control.ts";
import { availableBuiltinSkillNames, builtinSkillTool } from "./builtin-skills.ts";
import { createKnowledgeTools } from "./knowledge/tools.ts";
import {
  collectAgentTools,
  type ToolProvider,
  type ToolProvisionContext,
} from "../effectors/contracts/tool-provider.ts";
export { remapContainerPath } from "./execution-env.ts";

type AgentRecord = typeof agents.$inferSelect;

export function createServerExecution(
  agent: AgentRecord,
  codemodeHooks?: CodemodeHooks,
  userId?: string,
) {
  const browserRevision = {
    revision: agent.permissions.bash ? browserControl(agent.id).state.revision : 0,
  };
  const env = new AgentExecutionEnv(agent);
  const mcp = new AgentMcpTools(agent, env.hostCwd);
  const tools = createServerToolDefinitions(agent, env);
  const codemode = agent.codemodeEnabled ? createCarmelCodemode(codemodeHooks) : undefined;
  if (userId) tools.push(...createKnowledgeTools(userId, agent.id));
  return {
    env,
    extensions: codemode ? [codemode] : [],
    tools,
    async prepare(signal?: AbortSignal) {
      await mcp.connect({ signal });
      tools.push(...mcp.tools);
    },
    /** Compose session overrides before exposing the same tool set to codemode. */
    resolveTools(sessionTools: readonly ToolRegistration[] = []) {
      const overrides = new Set(sessionTools.map((tool) => tool.name));
      const available = [
        ...tools.filter((tool) => !overrides.has(tool.name)),
        ...sessionTools,
      ].filter((tool) => tool.name !== "codemode" && tool.name !== "load_builtin_skill");
      if (availableBuiltinSkillNames(agent).length) available.push(builtinSkillTool(agent, userId));
      const composed = codemode ? [...available, ...codemode.tools!] : available;
      // Gate the entire codemode batch so its deadline starts after human control ends.
      return agent.permissions.bash
        ? [
            ...composed.map((tool) => guardBrowserHandoff(agent.id, tool, browserRevision)),
            browserHelpTool(agent),
          ]
        : composed;
    },
    async cleanup(context: Context) {
      try {
        await mcp.close();
      } finally {
        await env.cleanup(context);
      }
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
): ToolRegistration[] {
  const context: ToolProvisionContext = {
    agentId: agent.id,
    workingDir: env.cwd,
    permissions: agent.permissions,
    env,
  };
  return collectAgentTools(providers, context).tools;
}
