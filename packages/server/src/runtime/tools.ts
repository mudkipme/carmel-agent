import { receiverCollaboration, assertReceiverAccess } from "../collaborations/access.ts";
import { db } from "../db/index.ts";
import { sessions, agents } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { ToolRegistration, Context } from "../effectors/pi-durable/index.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import { builtinToolProviders } from "./tool-providers/index.ts";
import { AgentMcpTools } from "./mcp-tools.ts";
import { createCarmelCodemode, type CodemodeHooks } from "./codemode-tool.ts";
import { browserHelpTool, guardBrowserHandoff } from "./browser-tools.ts";
import { browserControl } from "./browser-control.ts";
import { availableBuiltinSkillNames, builtinSkillTool } from "./builtin-skills.ts";
import { createKnowledgeTools } from "../knowledge/tools.ts";
import { redactSessionSecrets } from "./user-request-tools.ts";
import {
  collectAgentTools,
  type ToolProvider,
  type ToolProvisionContext,
} from "../effectors/contracts/tool-provider.ts";
export { remapContainerPath } from "./execution-env.ts";

type AgentRecord = typeof agents.$inferSelect;
const browserFreeTools = new Set(["request_browser_help", "ask_user_question", "request_secret"]);

export function createServerExecution(
  agent: AgentRecord,
  codemodeHooks?: CodemodeHooks,
  userId?: string,
  sessionId?: string,
) {
  const session = sessionId
    ? db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
    : undefined;
  const collaboration = sessionId ? receiverCollaboration(sessionId, session?.issueId) : undefined;
  const consultation = collaboration?.kind === "consult";
  if (consultation)
    agent = {
      ...agent,
      codemodeEnabled: false,
      mcpServers: [],
      permissions: { ...agent.permissions, write: false, edit: false, bash: false, network: false },
    };
  const browserRevision = {
    revision: agent.permissions.bash ? browserControl(agent.environmentId).state.revision : 0,
  };
  const env = new AgentExecutionEnv(agent, { sessionId });
  const mcp = new AgentMcpTools(agent, env.environment, env.hostCwd, sessionId);
  const tools = createServerToolDefinitions(agent, env);
  const codemode = agent.codemodeEnabled ? createCarmelCodemode(codemodeHooks) : undefined;
  if (userId) tools.push(...createKnowledgeTools(userId, agent.id));
  return {
    env,
    extensions: codemode ? [codemode] : [],
    tools,
    namespaces: mcp.namespaces,
    async prepare(signal?: AbortSignal) {
      await mcp.connect({ signal });
      tools.push(...mcp.tools);
    },
    /** Compose session overrides before exposing the same tool set to codemode. */
    resolveTools(sessionTools: readonly ToolRegistration[] = []) {
      const overrides = new Set(sessionTools.map((tool) => tool.name));
      const permitted = new Set([
        "read",
        "grep",
        "find",
        "ls",
        "knowledge_search",
        "knowledge_read",
        "read_collaboration",
        "send_agent_message",
      ]);
      const available = [
        ...tools.filter((tool) => !overrides.has(tool.name)),
        ...sessionTools,
      ].filter(
        (tool) =>
          tool.name !== "codemode" &&
          tool.name !== "load_builtin_skill" &&
          (!consultation || permitted.has(tool.name)),
      );
      if (!consultation && availableBuiltinSkillNames(agent).length)
        available.push(builtinSkillTool(agent, userId));
      const composed = codemode ? [...available, ...codemode.tools!] : available;
      return agent.permissions.bash ? [...composed, browserHelpTool(agent, sessionId)] : composed;
    },
    /** Carmel's policy around each resolved tool, applied natively to whichever same-named tool wins. */
    guards(resolved: readonly ToolRegistration[]): Extension {
      const guard = (base: ToolRegistration) => {
        let tool = base;
        // Gate the entire codemode batch so its deadline starts after human control ends.
        // Requests to the user never touch the browser, and a gate there could drop a woken response.
        if (agent.permissions.bash && !browserFreeTools.has(tool.name))
          tool = guardBrowserHandoff(agent.environmentId, tool, browserRevision);
        if (collaboration) {
          const inner = tool;
          tool = {
            ...inner,
            async execute(args, api, context) {
              assertReceiverAccess(sessionId!, session?.issueId);
              return inner.execute(args, api, context);
            },
          };
        }
        return sessionId ? redactSessionSecrets(tool, sessionId, agent.environmentId) : tool;
      };
      return defineExtension({
        name: "carmel.guards",
        wraps: resolved.map((tool) => ({ tool: tool.name, wrap: guard })),
      });
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
