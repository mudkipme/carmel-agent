import type { AgentHarnessTool, Context, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { agents } from "../db/schema.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import { builtinToolProviders } from "./tool-providers/index.ts";
import { AgentMcpTools } from "./mcp-tools.ts";
import {
  collectAgentTools,
  type ToolProvider,
  type ToolProvisionContext,
} from "../effectors/contracts/tool-provider.ts";
export { remapContainerPath } from "./execution-env.ts";

type AgentRecord = typeof agents.$inferSelect;

export function createServerExecution(agent: AgentRecord) {
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
