import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRecord } from "./records.ts";

// Pure, framework-agnostic helpers for inspecting and editing agent messages.
// These run on both the client (in-memory agent state) and the server
// (DB-loaded messages), so they must agree exactly — keep them here, not copied.

export function isUserMessage(message: AgentMessage): boolean {
  const role = (message as { role?: string }).role;
  return role === "user";
}

export function isEditableAssistantMessage(message: AgentMessage): message is AgentMessage & AssistantMessage {
  const current = message as { role?: string; content?: unknown };
  if (current.role !== "assistant" || !Array.isArray(current.content)) return false;
  let hasText = false;
  for (const part of current.content) {
    if (!isRecord(part)) continue;
    if (part.type === "toolCall") return false;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) hasText = true;
  }
  return hasText;
}

// Editing a user message can also drop images: `removedImageIndexes` refers to
// the position of an image among the inline image parts of `content` (in order),
// and both the client and server recompute from the same stored message.
export type UserMessageEditOptions = {
  removedImageIndexes?: number[];
};

export function updateUserMessageContent(
  message: AgentMessage,
  content: string,
  options?: UserMessageEditOptions,
): AgentMessage {
  if (!isUserMessage(message)) return message;
  const current = message as AgentMessage & { content?: unknown };
  const removedImages = new Set(options?.removedImageIndexes ?? []);

  if (typeof current.content === "string") {
    return { ...message, content } as AgentMessage;
  }
  if (!Array.isArray(current.content)) return message;

  let replacedText = false;
  let imageIndex = 0;
  const nextContent: unknown[] = [];
  for (const part of current.content) {
    if (isRecord(part) && part.type === "image") {
      const drop = removedImages.has(imageIndex);
      imageIndex += 1;
      if (drop) continue;
      nextContent.push(part);
      continue;
    }
    if (isRecord(part) && part.type === "text" && !replacedText) {
      replacedText = true;
      nextContent.push({ ...part, text: content });
      continue;
    }
    nextContent.push(part);
  }

  if (!replacedText) nextContent.unshift({ type: "text", text: content });
  return { ...message, content: nextContent } as AgentMessage;
}

export function updateAssistantMessageContent(message: AgentMessage, content: string): AgentMessage {
  const current = message as AgentMessage & { content?: unknown };
  if (!Array.isArray(current.content)) return message;

  let textSeen = false;
  const nextContent: unknown[] = [];
  for (const part of current.content) {
    if (isRecord(part) && part.type === "text") {
      // Collapse the edited text into the first text part and drop any trailing
      // text parts so the displayed (joined) text stays consistent after editing.
      if (textSeen) continue;
      textSeen = true;
      nextContent.push({ ...part, text: content });
    } else {
      nextContent.push(part);
    }
  }
  if (!textSeen) nextContent.push({ type: "text", text: content });
  return { ...message, content: nextContent } as AgentMessage;
}
