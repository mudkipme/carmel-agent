import type { AgentHarnessTool, ExecutionToolContext } from "../pi-durable/index.ts";

/** The agent capability a tool needs before it may be offered to the model. */
export type ToolCapability = "read" | "write" | "edit" | "bash" | "network";

export type ProvidedTool = {
  readonly providerId: string;
  /** Gate on an agent permission, or offer unconditionally when absent. */
  readonly requires?: ToolCapability;
  readonly tool: AgentHarnessTool<ExecutionToolContext>;
};

/** The execution environment and permissions used to build an agent's tools. */
export type ToolProvisionContext = {
  readonly agentId: string;
  readonly workingDir: string;
  readonly permissions: Readonly<Record<ToolCapability, boolean>>;
  /** The sandboxed execution environment. */
  readonly env: ExecutionToolContext["env"];
};

export interface ToolProvider {
  readonly id: string;
  readonly label: string;
  provide(context: ToolProvisionContext): readonly ProvidedTool[];
}

/** Compose tools with capability checks and first-registration name ownership. */
export function collectAgentTools(
  providers: readonly ToolProvider[],
  context: ToolProvisionContext,
): { tools: AgentHarnessTool<ExecutionToolContext>[]; skipped: SkippedTool[] } {
  const tools: AgentHarnessTool<ExecutionToolContext>[] = [];
  const skipped: SkippedTool[] = [];
  const claimed = new Map<string, string>();

  for (const provider of providers) {
    for (const provided of provider.provide(context)) {
      if (provided.requires && !context.permissions[provided.requires]) {
        skipped.push({
          providerId: provider.id,
          toolName: provided.tool.name,
          reason: "missing_permission",
        });
        continue;
      }
      // The first registration owns a tool name.
      const owner = claimed.get(provided.tool.name);
      if (owner) {
        skipped.push({
          providerId: provider.id,
          toolName: provided.tool.name,
          reason: "name_taken",
          takenBy: owner,
        });
        continue;
      }
      claimed.set(provided.tool.name, provider.id);
      tools.push(provided.tool);
    }
  }

  return { tools, skipped };
}

export type SkippedTool = {
  readonly providerId: string;
  readonly toolName: string;
  readonly reason: "missing_permission" | "name_taken";
  readonly takenBy?: string;
};
