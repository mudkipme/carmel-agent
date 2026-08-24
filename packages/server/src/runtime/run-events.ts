import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError, type AssistantMessageEvent, type ToolCall } from "@earendil-works/pi-ai";
import type { AgentRunEvent } from "@carmel-agent/shared";
import { classifyTurnFailure, formatTurnFailure, type TurnFailure } from "../effectors/failure-classifier.ts";

/**
 * Project one Pi harness event onto the client's wire protocol, or drop it.
 *
 * Pi's events are shaped for an in-process listener that can afford a fresh
 * snapshot per token; over a network they are the difference between O(n) and
 * O(n^2) bytes for a streamed reply. Everything the client does not read is
 * dropped here rather than at the far end of a slow link.
 */
/**
 * Classify the failure carried by a harness turn, if it carries one.
 *
 * Lives here because this is the layer allowed to know Pi: it is what supplies
 * `isRetryableAssistantError` as a hint so the classifier itself stays Pi-free.
 * The run path uses the same function, so what the user is told and what the
 * server decides to do about it cannot drift apart.
 */
export function classifyHarnessTurnFailure(event: AgentHarnessEvent): TurnFailure | undefined {
  if (event.type !== "turn_end" || event.message.role !== "assistant" || !event.message.errorMessage) return undefined;
  return classifyTurnFailure({
    message: event.message.errorMessage,
    aborted: event.message.stopReason === "aborted",
    transientHint: isRetryableAssistantError(event.message),
  });
}

export function projectRunEvent(event: AgentHarnessEvent): AgentRunEvent | undefined {
  switch (event.type) {
    case "message_start":
      // Only an assistant message seeds delta accumulation. Every other role is
      // emitted as a `message_start`/`message_end` pair in the same tick, so
      // forwarding the start would send that payload -- a whole tool result, or
      // a user message's base64 images -- a second time for no observable gain.
      return event.message.role === "assistant" ? { type: "message_start", message: event.message } : undefined;
    case "message_update":
      return projectMessageUpdate(event.assistantMessageEvent);
    case "message_end":
      return { type: "message_end", message: event.message };
    case "tool_execution_start":
      // `args` is dropped: the tool call itself already reached the client as a
      // `message_part`, and a write/edit call carries the entire file content.
      return { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName };
    case "tool_execution_end":
      // `result` is dropped for the same reason -- the authoritative tool result
      // arrives as its own `message_end`.
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "turn_end":
      // The other failure path. A provider rejection does not throw -- Pi turns
      // it into an assistant message with `stopReason: "error"` -- so classifying
      // only in `createAgentError` would leave the common case unimproved. Pi's
      // own transient verdict rides along as a hint; this is the layer that is
      // allowed to know Pi, so the classifier itself stays free of it.
      {
        const failure = classifyHarnessTurnFailure(event);
        return failure ? { type: "turn_end", errorMessage: formatTurnFailure(failure) } : { type: "turn_end" };
      }
    case "agent_end":
      // `messages` is the entire transcript, which the client already holds.
      return { type: "agent_end" };
    default:
      // `agent_start`/`turn_start` carry nothing the client renders,
      // `tool_execution_update.partialResult` can be megabytes of tool output it
      // ignores, and the harness's own lifecycle events have no observer.
      return undefined;
  }
}

function projectMessageUpdate(event: AssistantMessageEvent): AgentRunEvent | undefined {
  switch (event.type) {
    case "text_delta":
      return { type: "message_delta", contentIndex: event.contentIndex, field: "text", delta: event.delta };
    case "thinking_delta":
      return { type: "message_delta", contentIndex: event.contentIndex, field: "thinking", delta: event.delta };
    case "toolcall_start": {
      // Announce the call so its name and spinner render immediately; the
      // arguments follow once they have finished streaming.
      const part = event.partial.content[event.contentIndex];
      if (part?.type !== "toolCall") return undefined;
      return { type: "message_part", contentIndex: event.contentIndex, part: toolCallPart(part, {}) };
    }
    case "toolcall_end":
      return {
        type: "message_part",
        contentIndex: event.contentIndex,
        part: toolCallPart(event.toolCall, event.toolCall.arguments),
      };
    default:
      // `text_start`/`thinking_start` carry no content -- the first delta creates
      // the part. The matching `*_end` events only repeat what the deltas
      // already built. `toolcall_delta` is partial JSON that only Pi's salvage
      // parser can read, so arguments land whole at `toolcall_end` instead.
      return undefined;
  }
}

/** Rebuild the part explicitly: providers hang scratch fields (`partialJson`, `index`) off it. */
function toolCallPart(source: ToolCall, args: ToolCall["arguments"]): ToolCall {
  const part: ToolCall = { type: "toolCall", id: source.id, name: source.name, arguments: args ?? {} };
  if (source.thoughtSignature !== undefined) part.thoughtSignature = source.thoughtSignature;
  return part;
}
