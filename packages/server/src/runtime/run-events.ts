import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentRunEvent } from "@carmel-agent/shared";

/**
 * Project one Pi harness event onto the client's wire protocol, or drop it.
 *
 * Pi's events are shaped for an in-process listener that can afford a fresh
 * snapshot per token; over a network they are the difference between O(n) and
 * O(n^2) bytes for a streamed reply. Everything the client does not read is
 * dropped here rather than at the far end of a slow link.
 */
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
      return event.message.role === "assistant" && event.message.errorMessage
        ? { type: "turn_end", errorMessage: event.message.errorMessage }
        : { type: "turn_end" };
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
