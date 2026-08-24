import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";

/**
 * Where an agent's tools come from.
 *
 * The registry composes providers; it never learns whether a provider's tools
 * run in this process, in a loaded extension, or -- later -- behind an RPC
 * boundary in a sandbox. That last one is the reason this port exists at all:
 * moving extension execution out of the server process should be a second
 * adapter, not a second implementation of tool wiring.
 *
 * The second deliberate Pi leak in `contracts/`, after `messages.ts`, and for
 * the same reason: a tool *is* Pi's interface to the model, and re-modelling it
 * would mean reimplementing dispatch to gain nothing. It also happens to be
 * RPC-safe -- an out-of-process adapter returns objects of exactly this shape
 * whose `execute` performs a call instead of the work.
 */

/** The agent capability a tool needs before it may be offered to the model. */
export type ToolCapability = "read" | "write" | "edit" | "bash" | "network";

export type ProvidedTool = {
  readonly providerId: string;
  /** Gate on an agent permission, or offer unconditionally when absent. */
  readonly requires?: ToolCapability;
  readonly tool: AgentHarnessTool<ExecutionToolContext>;
};

/**
 * What a provider is told about the agent it is building tools for.
 *
 * Deliberately narrow and serializable apart from `env`: everything an
 * out-of-process provider could not be handed is something the registry should
 * not be promising providers in the first place.
 */
export type ToolProvisionContext = {
  readonly agentId: string;
  readonly workingDir: string;
  readonly permissions: Readonly<Record<ToolCapability, boolean>>;
  /** The sandboxed filesystem boundary. In-process providers only. */
  readonly env: ExecutionToolContext["env"];
};

export interface ToolProvider {
  readonly id: string;
  /** `builtin` ships with Carmel; `extension` is admin-installed third-party code. */
  readonly source: "builtin" | "extension";
  readonly label: string;
  provide(context: ToolProvisionContext): readonly ProvidedTool[];
}

/**
 * Compose providers into the tool list for one agent.
 *
 * Capability gating happens here rather than inside providers so that a
 * provider cannot grant itself a permission the agent was not given -- which
 * matters most for the providers Carmel did not write.
 */
export function collectAgentTools(
  providers: readonly ToolProvider[],
  context: ToolProvisionContext,
  options?: { readonly enabledProviderIds?: ReadonlySet<string> },
): { tools: AgentHarnessTool<ExecutionToolContext>[]; skipped: SkippedTool[] } {
  const tools: AgentHarnessTool<ExecutionToolContext>[] = [];
  const skipped: SkippedTool[] = [];
  const claimed = new Map<string, string>();

  for (const provider of providers) {
    if (provider.source === "extension" && options?.enabledProviderIds && !options.enabledProviderIds.has(provider.id)) {
      skipped.push({ providerId: provider.id, toolName: "*", reason: "provider_not_enabled" });
      continue;
    }

    for (const provided of provider.provide(context)) {
      if (provided.requires && !context.permissions[provided.requires]) {
        skipped.push({ providerId: provider.id, toolName: provided.tool.name, reason: "missing_permission" });
        continue;
      }
      // First registration wins, and built-ins are ordered first, so an
      // extension cannot shadow `read` or `bash` with its own implementation.
      const owner = claimed.get(provided.tool.name);
      if (owner) {
        skipped.push({ providerId: provider.id, toolName: provided.tool.name, reason: "name_taken", takenBy: owner });
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
  readonly reason: "missing_permission" | "name_taken" | "provider_not_enabled";
  readonly takenBy?: string;
};
