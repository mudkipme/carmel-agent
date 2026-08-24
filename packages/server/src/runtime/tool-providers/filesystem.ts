import {
  createFindTool as createPiFindTool,
  createGrepTool as createPiGrepTool,
  createLsTool as createPiLsTool,
  type FindToolInput,
  type GrepToolInput,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import type { AgentExecutionEnv } from "../execution-env.ts";
import { createGrepOperations, createLsOperations } from "../search-operations.ts";
import type { ProvidedTool, ToolProvider, ToolProvisionContext } from "../../effectors/contracts/tool-provider.ts";

type ServerToolDefinition = AgentHarnessTool<ExecutionToolContext>;

/**
 * The tools that reach the agent's workspace.
 *
 * One provider rather than four, because these share the execution environment
 * that enforces the workspace boundary and they are meaningless apart from it.
 * The per-tool `requires` is what splits them, so an agent with read but not
 * write still gets exactly the set it did before this became a registry.
 */
export const filesystemToolProvider: ToolProvider = {
  id: "carmel.filesystem",
  source: "builtin",
  label: "Workspace files",
  provide(context: ToolProvisionContext): ProvidedTool[] {
    const env = context.env as AgentExecutionEnv;
    const own = (requires: ProvidedTool["requires"], tool: ServerToolDefinition): ProvidedTool => ({
      providerId: filesystemToolProvider.id,
      requires,
      tool,
    });

    return [
      own("read", createReadTool<ExecutionToolContext>()),
      own("read", createAuthorizedGrepTool(env)),
      own("read", createAuthorizedFindTool(env)),
      own("read", createPiLsTool(env.cwd, { operations: createLsOperations(env) })),
      own("write", createWriteTool<ExecutionToolContext>()),
      own("edit", createEditTool<ExecutionToolContext>()),
    ];
  },
};

/** Shell access. Separate because it is the one that runs in a container. */
export const bashToolProvider: ToolProvider = {
  id: "carmel.bash",
  source: "builtin",
  label: "Sandboxed shell",
  provide(): ProvidedTool[] {
    return [{ providerId: bashToolProvider.id, requires: "bash", tool: createBashTool<ExecutionToolContext>() }];
  },
};

function createAuthorizedFindTool(env: AgentExecutionEnv): ServerToolDefinition {
  const tool = createPiFindTool(env.cwd);
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params as FindToolInput;
      const path = env.resolveAuthorizedPath(args.path || ".", "read");
      return tool.execute(toolCallId, { ...args, path }, signal, onUpdate);
    },
  };
}

// GrepOperations protects metadata and context reads, but Pi still passes the
// original search path to its host rg process. Resolve it first so container
// mount aliases are remapped and rg never receives an unauthorized host path.
function createAuthorizedGrepTool(env: AgentExecutionEnv): ServerToolDefinition {
  const tool = createPiGrepTool(env.cwd, { operations: createGrepOperations(env) });
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params as GrepToolInput;
      const path = env.resolveAuthorizedPath(args.path || ".", "read");
      return tool.execute(toolCallId, { ...args, path }, signal, onUpdate);
    },
  };
}
