import type { AgentEvent } from "@earendil-works/pi-durable";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { type AgentRunEvent } from "@carmel-agent/shared";
import { displayEntries } from "../services/pi-session-storage.ts";
import {
  classifyTurnFailure,
  formatTurnFailure,
  type TurnFailure,
} from "../effectors/failure-classifier.ts";

export function isOverflowMessage(message: string): boolean {
  return isContextOverflow({ stopReason: "error", errorMessage: message } as AssistantMessage);
}

export function classifyAssistantFailure(
  message: AssistantMessage,
  contextWindow?: number,
): TurnFailure | undefined {
  const overflowHint = isContextOverflow(message, contextWindow);
  if (!message.errorMessage && !overflowHint) return undefined;
  return classifyTurnFailure({
    message: message.errorMessage ?? "",
    aborted: message.stopReason === "aborted",
    transientHint: isRetryableAssistantError(message),
    overflowHint,
  });
}

/** Native events cross the wire directly, with bulk output and partial argument JSON omitted. */
export function projectRunEvent(
  event: AgentEvent,
  failure?: TurnFailure,
): AgentRunEvent | undefined {
  switch (event.type) {
    case "message_start":
      return event.message.role === "assistant" ? event : undefined;
    case "message_update": {
      const changes = event.changes
        .filter((change) => change.type !== "toolcall_delta")
        .map((change) => {
          if (!("block" in change) || change.block.type !== "toolCall") return change;
          const { id, name, arguments: args, thoughtSignature } = change.block;
          return {
            ...change,
            block: {
              type: "toolCall" as const,
              id,
              name,
              arguments: args ?? {},
              ...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
            },
          };
        });
      return changes.length ? { ...event, changes } : undefined;
    }
    case "message_end": {
      const display = displayEntries([event.entry])[0];
      return display?.type === "message"
        ? { type: "message_end", message: display.message }
        : undefined;
    }
    case "snapshot":
      return { type: "nested_tools", tools: event.nestedTools };
    case "tool_execution_start":
      return event;
    case "tool_execution_end": {
      const { entry: _entry, result, ...call } = event;
      if (!result) return call;
      const { structuredOutput: _output, details: _details, ...summary } = result;
      return { ...call, result: summary };
    }
    case "tool_execution_update":
      return event.parentToolCallId ? event : undefined;
    case "turn_end":
      return { type: "turn_end", ...(failure ? { errorMessage: formatTurnFailure(failure) } : {}) };
    case "run_end":
      return { type: "agent_end" };
    default:
      return undefined;
  }
}
