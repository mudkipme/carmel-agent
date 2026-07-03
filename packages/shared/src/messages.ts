import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Pure, framework-agnostic helpers for inspecting and editing agent messages.
// These run on both the client (in-memory agent state) and the server
// (DB-loaded messages), so they must agree exactly — keep them here, not copied.

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isUserMessage(message: AgentMessage): boolean {
  const role = (message as { role?: string }).role;
  return role === "user" || role === "user-with-attachments";
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
// and `removedAttachmentIds` to ids in the legacy `attachments` array. Both the
// client (optimistic) and server recompute from the same stored message, so
// index-based removal stays in sync.
export type UserMessageEditOptions = {
  removedImageIndexes?: number[];
  removedAttachmentIds?: string[];
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
    return pruneAttachments({ ...message, content } as AgentMessage, options);
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
  return pruneAttachments({ ...message, content: nextContent } as AgentMessage, options);
}

function pruneAttachments(message: AgentMessage, options?: UserMessageEditOptions): AgentMessage {
  const removedAttachments = new Set(options?.removedAttachmentIds ?? []);
  if (removedAttachments.size === 0) return message;
  const attachments = (message as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return message;
  const nextAttachments = attachments.filter(
    (attachment) => !(isRecord(attachment) && typeof attachment.id === "string" && removedAttachments.has(attachment.id)),
  );
  return { ...message, attachments: nextAttachments } as AgentMessage;
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
