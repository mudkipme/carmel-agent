/** Carmel's tool invocation contract, adapted to Pi Durable at the registry boundary. */
export * from "@earendil-works/pi-durable/env";
export { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
export type { Context, JsonValue } from "@earendil-works/chord";
export type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
export { truncateHead } from "@earendil-works/pi-coding-agent";
export { DEFAULT_COMPACTION_POLICY as DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-durable";
export { formatSkillsForSystemPrompt, formatSkillInvocation, loadSkills, loadPromptTemplates, formatPromptTemplateInvocation, parseCommandArgs } from "./resources.ts";
export type { Skill, SkillDiagnostic, PromptTemplate, PromptTemplateDiagnostic } from "./resources.ts";
export { AgentHarness } from "./harness.ts";
export type { AgentHarnessOptions, AgentLane } from "./harness.ts";
export type { PiSession as Session, DisplayEntry as Entry } from "../../services/pi-session-storage.ts";
import type { Context } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, Tool } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { estimateContextTokens as estimatePiContextTokens } from "@earendil-works/pi-ai/utils/estimate";
export { createReadTool, createWriteTool, createEditTool, createBashTool } from "./tools.ts";
export type AgentToolResult = Omit<import("@earendil-works/pi-agent-core").AgentToolResult, "details"> & { details?: unknown; useStreamedOutput?: boolean; diagnostics?: readonly import("@earendil-works/pi-durable").ToolDiagnostic[] };
export type ExecutionToolContext = { env: ExecutionEnv };
export type AgentHarnessToolInvocation = {
  durableApi?: import("@earendil-works/pi-durable").ToolExecutionApi;
  invocationId: string;
  operationId: string;
  turnId: string;
};
export type AgentHarnessTool<TContext = ExecutionToolContext> = Tool & {
  label: string;
  executionMode?: "parallel" | "sequential";
  outputSchema?: unknown;
  replay?: "safe" | "unsafe";
  outputLimits?: import("@earendil-works/pi-durable").ToolRegistration["outputLimits"];
  prepareArguments?(args: unknown): unknown;
  execute(id: string, args: any, update: (result: AgentToolResult, options?: { checkpoint?: boolean }) => void, tools: TContext, invocation: AgentHarnessToolInvocation, context: Context): Promise<AgentToolResult>;
};
export type HarnessEvent =
  | { type: "message_start" | "message_end"; message: AgentMessage }
  | { type: "message_update"; event: AssistantMessageEvent }
  | { type: "message_part"; contentIndex: number; part: AssistantMessage["content"][number] }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; toolName: string; partialResult: AgentToolResult }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; result?: unknown }
  | { type: "turn_end"; message: AssistantMessage; toolResults: unknown[] }
  | { type: "run_end" | "run_start" | "turn_start" }
  | { type: "queue_update"; queues: { entryId: string }[] }
  | { type: "compaction_end"; reason: "threshold" | "overflow" | "manual"; status: "completed" | "failed" | "skipped"; error: { message: string } };
export type HarnessEventType = HarnessEvent["type"];
export function estimateContextTokens(messages: AgentMessage[]) {
  return estimatePiContextTokens(messages.filter((m): m is import("@earendil-works/pi-ai").Message => ["user", "assistant", "toolResult", "system"].includes(m.role)));
}
export type ResolvedModel = Model<Api>;
