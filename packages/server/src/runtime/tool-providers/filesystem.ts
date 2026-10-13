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
  type ToolRegistration,
  type AgentTool,
} from "../../effectors/pi-durable/index.ts";
import type { AgentExecutionEnv } from "../execution-env.ts";
import { createGrepOperations, createLsOperations } from "../search-operations.ts";
import type {
  ProvidedTool,
  ToolProvider,
  ToolProvisionContext,
} from "../../effectors/contracts/tool-provider.ts";

type ServerToolDefinition = ToolRegistration;

/** Only grep/find/ls still come from Pi's Agent-loop package. */
function asDurableTool(tool: AgentTool): ServerToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: "safe",
    async execute(args, api, context) {
      const result = await tool.execute(api.callId, args, context.abortSignal);
      return { output: result.content, details: result.details };
    },
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
      own("read", createReadTool()),
      own("read", createAuthorizedGrepTool(env)),
      own("read", createAuthorizedFindTool(env)),
      own("read", asDurableTool(createPiLsTool(env.cwd, { operations: createLsOperations(env) }))),
      own("write", createWriteTool()),
      own("edit", createEditTool()),
    ];
  },
};

/** Shell access. Separate because it is the one that runs in a container. */
export const bashToolProvider: ToolProvider = {
  id: "carmel.bash",
  label: "Sandboxed shell",
  provide(): ProvidedTool[] {
    return [
      {
        providerId: bashToolProvider.id,
        requires: "bash",
        tool: createBashTool(),
      },
    ];
  },
};

function createAuthorizedFindTool(env: AgentExecutionEnv): ServerToolDefinition {
  // Pi spawns fd/rg in the server. Only their structured search paths use host storage.
  const tool = createPiFindTool(env.hostCwd);
  return asDurableTool({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params as FindToolInput;
      const path = env.resolveAuthorizedPath(args.path || ".", "read");
      try {
        return await tool.execute(toolCallId, { ...args, path }, signal, onUpdate);
      } catch (error) {
        throw env.toAgentError(error);
      }
    },
  });
}

// GrepOperations protects metadata and context reads, but Pi still passes the
// original search path to its host rg process. Resolve it first so container
// mount aliases are remapped and rg never receives an unauthorized host path.
function createAuthorizedGrepTool(env: AgentExecutionEnv): ServerToolDefinition {
  const tool = createPiGrepTool(env.hostCwd, { operations: createGrepOperations(env) });
  return asDurableTool({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params as GrepToolInput;
      const path = env.resolveAuthorizedPath(args.path || ".", "read");
      try {
        return await tool.execute(toolCallId, { ...args, path }, signal, onUpdate);
      } catch (error) {
        throw env.toAgentError(error);
      }
    },
  });
}
