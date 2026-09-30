import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { agents } from "../db/schema.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import { builtinToolProviders } from "./tool-providers/index.ts";
import {
  collectAgentTools,
  type ToolProvider,
  type ToolProvisionContext,
} from "../effectors/contracts/tool-provider.ts";
export { remapContainerPath } from "./execution-env.ts";

type AgentRecord = typeof agents.$inferSelect;

export function createServerExecution(agent: AgentRecord) {
  const env = new AgentExecutionEnv(agent);
  return {
    env,
    toolContext: { env } satisfies ExecutionToolContext,
    tools: createServerToolDefinitions(agent, env),
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
