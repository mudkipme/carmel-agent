import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRunEvent } from "./index.ts";

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
