import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { agents } from "../db/schema.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import { getToolProviders } from "./extension-registry.ts";
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
 * Build one agent's tool list from the registered providers.
 *
 * The permission booleans used to be `if` statements around individual
 * constructors here. They are now a capability each tool declares, checked by
 * `collectAgentTools` rather than by the provider -- which is what stops a
 * provider Carmel did not write from handing itself a permission the agent was
 * never granted.
 */
export function createServerToolDefinitions(
  agent: AgentRecord,
  env = new AgentExecutionEnv(agent),
  providers: readonly ToolProvider[] = getToolProviders(),
): AgentHarnessTool<ExecutionToolContext>[] {
  const context: ToolProvisionContext = {
    agentId: agent.id,
    workingDir: env.cwd,
    permissions: agent.permissions,
    env,
  };
  // Only the agent's own allowlist arms extension providers. Built-ins ignore
  // it, so an agent that has never been configured keeps exactly the tools it
  // had before extensions existed.
  return collectAgentTools(providers, context, {
    enabledProviderIds: new Set(agent.enabledExtensions ?? []),
  }).tools;
}
