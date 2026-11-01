import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRunEvent, NestedToolSlot } from "./index.ts";

export type RunProgress = {
  streamingMessage?: AgentMessage;
  pendingToolCalls: string[];
  nestedTools: readonly NestedToolSlot[];
  errorMessage?: string;
  contextPressure?: { level: "warning" | "critical"; message: string };
};

export function applyRunProgress(progress: RunProgress, event: AgentRunEvent): RunProgress {
  switch (event.type) {
    case "message_start":
    case "message_update":
      return {
        ...progress,
        streamingMessage: applyStreamingEvent(progress.streamingMessage, event),
      };
    case "message_end":
    case "agent_end":
      return { ...progress, streamingMessage: undefined };
    case "tool_execution_start": {
      if (!event.parentToolCallId || !event.taskId || !event.parentTaskId)
        return {
          ...progress,
          pendingToolCalls: [...new Set([...progress.pendingToolCalls, event.toolCallId])],
        };
      const slot: NestedToolSlot = {
        callId: event.toolCallId,
        name: event.toolName,
        taskId: event.taskId,
        parentCallId: event.parentToolCallId,
        parentTaskId: event.parentTaskId,
        arguments: event.args,
        status: "running",
      };
      return {
        ...progress,
        nestedTools: [...progress.nestedTools.filter((call) => call.callId !== slot.callId), slot],
      };
    }
    case "tool_execution_update":
      return {
        ...progress,
        nestedTools: progress.nestedTools.map((call) => {
          if (call.callId !== event.toolCallId) return call;
          const { output, details, diagnostics } = event;
          return {
            ...call,
            ...(output
              ? {
                  output:
                    "set" in output
                      ? output.set
                      : (call.output ?? "").slice(output.trimStart ?? 0) + (output.append ?? ""),
                }
              : {}),
            ...(details !== undefined ? { details } : {}),
            ...(diagnostics ? { diagnostics: [...diagnostics] } : {}),
          };
        }),
      };
    case "tool_execution_end":
      if (!event.parentToolCallId)
        return {
          ...progress,
          pendingToolCalls: progress.pendingToolCalls.filter((id) => id !== event.toolCallId),
        };
      return {
        ...progress,
        nestedTools: progress.nestedTools.map((call) =>
          call.callId === event.toolCallId
            ? {
                ...call,
                status: "done",
                ...(event.result
                  ? {
                      summary: {
                        isError: event.result.isError,
                        durationMs: event.result.durationMs,
                      },
                    }
                  : {}),
              }
            : call,
        ),
      };
    case "nested_tools":
      return { ...progress, nestedTools: event.tools };
    case "run_finished":
      return { ...progress, streamingMessage: undefined, pendingToolCalls: [], nestedTools: [] };
    case "turn_end":
      return event.errorMessage ? { ...progress, errorMessage: event.errorMessage } : progress;
    case "context_pressure":
      return { ...progress, contextPressure: { level: event.level, message: event.message } };
    case "run_recovered":
      return {
        ...progress,
        errorMessage: undefined,
        contextPressure: { level: "warning", message: event.message },
      };
    default:
      return progress;
  }
}

type StreamingEvent = Extract<AgentRunEvent, { type: "message_start" | "message_update" }>;

/** Apply Pi's committed batched changes; full messages replace state after backlog recovery. */
export function applyStreamingEvent(
  message: AgentMessage | undefined,
  event: StreamingEvent,
): AgentMessage | undefined {
  if (event.type === "message_start") return event.message;
  for (const change of event.changes) {
    if (change.type === "message") {
      message = change.message;
      continue;
    }
    if (!message || message.role !== "assistant" || change.type === "toolcall_delta") continue;
    if (!Number.isInteger(change.contentIndex) || change.contentIndex < 0) continue;
    const content = [...message.content];
    while (content.length <= change.contentIndex) content.push({ type: "text", text: "" });
    if ("block" in change) content[change.contentIndex] = change.block;
    else {
      const previous = content[change.contentIndex];
      content[change.contentIndex] =
        change.type === "text_delta"
          ? {
              ...(previous?.type === "text" ? previous : {}),
              type: "text",
              text: (previous?.type === "text" ? previous.text : "") + change.delta,
            }
          : {
              ...(previous?.type === "thinking" ? previous : {}),
              type: "thinking",
              thinking: (previous?.type === "thinking" ? previous.thinking : "") + change.delta,
            };
    }
    message = { ...message, content, usage: event.usage };
  }
  return message;
}

export function isStreamingEvent(event: AgentRunEvent): event is StreamingEvent {
  return event.type === "message_start" || event.type === "message_update";
}
