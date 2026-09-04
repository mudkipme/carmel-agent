import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEvent,
  type ToolCall,
} from "@earendil-works/pi-ai";
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
 * `isRetryableAssistantError` and `isContextOverflow` as hints so the classifier
 * itself stays Pi-free. The run path uses the same function, so what the user is
 * told and what the server decides to do about it cannot drift apart.
 *
 * `contextWindow` is optional and worth passing wherever it is known. Without it
 * `isContextOverflow` can only read the error text; with it, it also catches the
 * providers that answer `stop` on a request whose input already exceeded the
 * window -- an overflow with no error message at all, which no amount of pattern
 * matching would find.
 */
/**
 * Pi's overflow verdict for a bare error string.
 *
 * For the paths that hold an exception rather than an assistant message -- a
 * provider that throws instead of answering. Only the error-text half of
 * `isContextOverflow` can apply, but that is the half a string has, and running
 * it through Pi keeps the pattern list in one place instead of growing a second
 * copy here for the callers that lack a message.
 */
export function isOverflowMessage(message: string): boolean {
  return isContextOverflow({ stopReason: "error", errorMessage: message } as AssistantMessage);
}

export function classifyHarnessTurnFailure(
  event: HarnessEvent,
  contextWindow?: number,
): TurnFailure | undefined {
  // 0.85 types `turn_end.message` as an `AssistantMessage` outright, so the
  // role check the 0.83 union needed is gone with it.
  if (event.type !== "turn_end") return undefined;
  const overflowHint = isContextOverflow(event.message, contextWindow);
  if (!event.message.errorMessage && !overflowHint) return undefined;
  return classifyTurnFailure({
    message: event.message.errorMessage ?? "",
    aborted: event.message.stopReason === "aborted",
    transientHint: isRetryableAssistantError(event.message),
    overflowHint,
  });
}

export function projectRunEvent(event: HarnessEvent): AgentRunEvent | undefined {
  switch (event.type) {
    case "message_start":
      // Only an assistant message seeds delta accumulation. Every other role is
      // emitted as a `message_start`/`message_end` pair in the same tick, so
      // forwarding the start would send that payload -- a whole tool result, or
      // a user message's base64 images -- a second time for no observable gain.
      return event.message.role === "assistant" ? { type: "message_start", message: event.message } : undefined;
    case "message_update":
      return projectMessageUpdate(event.event);
    case "message_end":
      return { type: "message_end", message: event.message };
    case "tool_start":
      // `args` is dropped: the tool call itself already reached the client as a
      // `message_part`, and a write/edit call carries the entire file content.
      return { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName };
    case "tool_end":
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
    case "run_end":
      // Formerly `agent_end`. Its payload is the whole transcript, which the
      // client already holds.
      return { type: "agent_end" };
    default:
      // `run_start`/`turn_start` carry nothing the client renders,
      // `tool_update.partialResult` can be megabytes of tool output it ignores,
      // and the harness's own lifecycle, config, usage and lane events -- most
      // of them new in 0.85 -- have no observer on the wire protocol.
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
