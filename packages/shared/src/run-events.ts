import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRunEvent } from "./index.ts";

// The other half of the run event protocol: the server projects Pi's events down
// to deltas (see the server's `runtime/run-events.ts`), and this rebuilds the
// streaming message from them. The two must agree exactly, so this lives here
// rather than only in the client -- it is what the server's protocol tests
// reassemble with.

type StreamingEvent = Extract<AgentRunEvent, { type: "message_start" | "message_delta" | "message_part" }>;

/**
 * Fold one streaming event into the message being received, returning the new
 * message. Returns a fresh object on every change: consumers compare snapshots
 * by identity to decide whether to re-render.
 *
 * A delta with nothing to append to is dropped rather than applied to a
 * synthetic message. That happens only when a client joins a run whose
 * `message_start` has already aged out of the server's replay buffer, and the
 * closing `message_end` carries the authoritative message either way.
 */
export function applyStreamingEvent(
  message: AgentMessage | undefined,
  event: StreamingEvent,
): AgentMessage | undefined {
  if (event.type === "message_start") return event.message;

  const content = streamingContent(message, event.contentIndex);
  if (!content) return message;

  if (event.type === "message_part") {
    content[event.contentIndex] = event.part;
    return { ...message, content } as AgentMessage;
  }

  const existing = content[event.contentIndex];
  if (event.field === "text") {
    content[event.contentIndex] =
      existing?.type === "text" ? { ...existing, text: existing.text + event.delta } : { type: "text", text: event.delta };
  } else {
    content[event.contentIndex] =
      existing?.type === "thinking"
        ? { ...existing, thinking: existing.thinking + event.delta }
        : { type: "thinking", thinking: event.delta };
  }
  return { ...message, content } as AgentMessage;
}

export function isStreamingEvent(event: AgentRunEvent): event is StreamingEvent {
  return event.type === "message_start" || event.type === "message_delta" || event.type === "message_part";
}

/**
 * A mutable copy of the streaming message's content, long enough to hold
 * `contentIndex`. Padding matters: renderers read `part.type` on every element,
 * so a sparse array would put holes in front of them.
 */
function streamingContent(message: AgentMessage | undefined, contentIndex: number) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  if (!Number.isInteger(contentIndex) || contentIndex < 0) return undefined;
  const content = [...message.content];
  while (content.length <= contentIndex) content.push({ type: "text", text: "" });
  return content;
}
