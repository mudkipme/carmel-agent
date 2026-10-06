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
  type AgentTool,
  type ExecutionToolContext,
} from "../../effectors/pi-durable/index.ts";
import type { AgentExecutionEnv } from "../execution-env.ts";
import { createGrepOperations, createLsOperations } from "../search-operations.ts";
import type { ProvidedTool, ToolProvider, ToolProvisionContext } from "../../effectors/contracts/tool-provider.ts";

type ServerToolDefinition = AgentHarnessTool<ExecutionToolContext>;

/**
 * Present an `Agent`-loop tool as a harness tool.
 *
 * Pi coding-agent's grep/find/ls take an abort signal third. Carmel's tool
 * providers share an invocation context, so this adapter extracts the signal
 * and passes the update callback in coding-agent's expected position.
 */
function asHarnessTool(tool: AgentTool): ServerToolDefinition {
  return {
    ...tool,
    replay: tool.replay === "safe" ? "safe" : "unsafe",
    execute: (toolCallId, params, onUpdate, _toolContext, _invocation, context) =>
      tool.execute(toolCallId, params, context.abortSignal, onUpdate),
  };
}

/**
 * The tools that reach the agent's workspace.
 *
 * One provider rather than four, because these share the execution environment
 * that enforces the workspace boundary and they are meaningless apart from it.
 * The per-tool `requires` is what splits them, so an agent with read but not
 * write still gets only the tools its permissions allow.
 */
export const filesystemToolProvider: ToolProvider = {
  id: "carmel.filesystem",
  label: "Workspace files",
  provide(context: ToolProvisionContext): ProvidedTool[] {
    const env = context.env as AgentExecutionEnv;
    const own = (requires: ProvidedTool["requires"], tool: ServerToolDefinition): ProvidedTool => ({
      providerId: filesystemToolProvider.id,
      requires,
      tool,
    });

    return [
      own("read", createReadTool<ExecutionToolContext>({ resolveImagePath: path => env.resolveAuthorizedPath(path, "read") })),
      own("read", createAuthorizedGrepTool(env)),
      own("read", createAuthorizedFindTool(env)),
      own("read", asHarnessTool(createPiLsTool(env.cwd, { operations: createLsOperations(env) }))),
      own("write", createWriteTool<ExecutionToolContext>()),
      own("edit", createEditTool<ExecutionToolContext>()),
    ];
  },
};

/** Shell access. Separate because it is the one that runs in a container. */
export const bashToolProvider: ToolProvider = {
  id: "carmel.bash",
  label: "Sandboxed shell",
  provide(): ProvidedTool[] {
    return [{ providerId: bashToolProvider.id, requires: "bash", tool: createBashTool<ExecutionToolContext>() }];
  },
};

function createAuthorizedFindTool(env: AgentExecutionEnv): ServerToolDefinition {
  // Pi spawns fd/rg in the server. Only their structured search paths use host storage.
  const tool = createPiFindTool(env.hostCwd);
  return asHarnessTool({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params as FindToolInput;
      const path = env.resolveAuthorizedPath(args.path || ".", "read");
      try { return await tool.execute(toolCallId, { ...args, path }, signal, onUpdate); }
      catch (error) { throw env.toAgentError(error); }
    },
  });
}

// GrepOperations protects metadata and context reads, but Pi still passes the
// original search path to its host rg process. Resolve it first so container
// mount aliases are remapped and rg never receives an unauthorized host path.
function createAuthorizedGrepTool(env: AgentExecutionEnv): ServerToolDefinition {
  const tool = createPiGrepTool(env.hostCwd, { operations: createGrepOperations(env) });
  return asHarnessTool({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params as GrepToolInput;
      const path = env.resolveAuthorizedPath(args.path || ".", "read");
      try { return await tool.execute(toolCallId, { ...args, path }, signal, onUpdate); }
      catch (error) { throw env.toAgentError(error); }
    },
  });
}
