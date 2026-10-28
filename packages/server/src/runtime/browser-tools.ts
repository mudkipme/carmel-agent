import type { ToolRegistration } from "../effectors/pi-durable/index.ts";
import type { agents } from "../db/schema.ts";
import { browserControl } from "./browser-control.ts";
import { execSandboxCommand } from "./sandbox/bash-operations.ts";
import { resolveAgentWorkingDirPath } from "./resources.ts";

type Tool = ToolRegistration;

export function guardBrowserHandoff(
  agentId: string,
  tool: Tool,
  observed: { revision: number },
): Tool {
  return {
    ...tool,
    async execute(...args) {
      const control = browserControl(agentId);
      const lease = await control.enter(args[2].abortSignal);
      try {
        if (lease.interrupted || observed.revision !== control.state.revision) {
          observed.revision = control.state.revision;
          return {
            output: [
              {
                type: "text",
                text: "This tool call was not executed: a human took control of the browser since your last action. Take a fresh agent-browser snapshot, verify the current page, and reconsider this call before continuing.",
              },
            ],
            details: {},
          };
        }
        return await tool.execute(...args);
      } finally {
        lease.release();
      }
    },
  };
}

/** Deliberately outside codemode: a human wait must not inherit its 60-second VM deadline. */
export function browserHelpTool(agent: typeof agents.$inferSelect, sessionId?: string): Tool {
  return {
    name: "request_browser_help",
    callers: ["model"],
    description:
      "Pause this agent's tools and ask a person to help in the shared browser, for example to sign in or complete verification. Open the site with agent-browser first. Call this tool directly, outside codemode. It waits until a person selects Resume agent and returns a fresh browser snapshot. Never ask for passwords in chat.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description:
            "A short explanation of what the person needs to do in the browser. Do not include credentials.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    async execute(args, api, context) {
      const reason = String((args as { reason: string }).reason).trim();
      if (!reason || reason.length > 1000)
        throw new Error("Give a brief reason for browser assistance.");
      const control = browserControl(agent.id);
      const waiting = control.requestHelp(reason, context.abortSignal);
      api.output(`Waiting for browser assistance: ${reason}`);
      await waiting;
      const lease = await control.enter(context.abortSignal);
      try {
        let snapshot = "";
        const result = await execSandboxCommand(
          agent,
          "agent-browser --session carmel snapshot",
          resolveAgentWorkingDirPath(agent),
          {
            signal: context.abortSignal,
            timeout: 25,
            sessionId,
            onStdout: (chunk) => {
              snapshot = (snapshot + chunk).slice(0, 40000);
            },
          },
        );
        return {
          output: [
            {
              type: "text",
              text: `The person resumed the agent. Verify whether the requested action succeeded before continuing. Previous browser refs are stale.\n${result.exitCode === 0 ? snapshot : "Take a fresh browser snapshot before continuing."}`,
            },
          ],
          details: {},
        };
      } finally {
        lease.release();
      }
    },
  };
}

export const browserInstructions = `Browser: use installed agent-browser with AGENT_BROWSER_SESSION=carmel; do not create another session/profile for ordinary browsing. This agent's browser, tabs, cookies, and saved sign-ins are shared across its conversations and users, and visible/controllable in Carmel's Browser pane. Run automation only in foreground tool calls so human handoff can pause it. For sign-in or human verification, open the site and call request_browser_help directly, outside codemode, with a brief reason; never ask for passwords in chat. After handoff, take a fresh snapshot and verify the page before acting. Leave the browser open when requesting help and after ordinary work; its profile persists.`;
