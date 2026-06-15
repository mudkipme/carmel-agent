import type { AgentConfig, ModelRef, ProviderConfig, Session, SessionMetadata, User } from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { agents, modelRefs, providerConfigs, sessions, users } from "./db/schema.ts";
import { defaultAgentWorkingDir } from "./paths.ts";
import type { SessionWithMessages } from "./services/session-store.ts";

export function serializeUser(user: typeof users.$inferSelect): User {
  return {
    id: user.id,
    username: user.username ?? undefined,
    name: user.name,
    email: user.email,
    role: user.role ?? "user",
    fastTaskModelRefId: user.fastTaskModelRefId ?? undefined,
  };
}

export function serializePublicAgent(agent: typeof agents.$inferSelect): AgentConfig {
  const settings = serializeAgentSettings(agent);
  return {
    ...settings,
    systemPrompt: "",
    promptTemplates: [],
  };
}

export function serializeAgentSettings(agent: typeof agents.$inferSelect): AgentConfig {
  return {
    ...agent,
    workingDirMode: agent.workingDirMode ?? "manual",
    defaultWorkingDir: agent.defaultWorkingDir ?? defaultAgentWorkingDir(agent.id),
    defaultThinkingLevel: agent.defaultThinkingLevel ?? "off",
  };
}

export function serializeModelRef(model: typeof modelRefs.$inferSelect): ModelRef {
  return {
    ...model,
    providerConfigId: model.providerConfigId ?? undefined,
    api: model.api ?? undefined,
    baseUrl: model.baseUrl ?? undefined,
    contextWindow: model.contextWindow ?? undefined,
    maxTokens: model.maxTokens ?? undefined,
  };
}

export function serializeProviderConfig(providerConfig: typeof providerConfigs.$inferSelect): ProviderConfig {
  return {
    ...providerConfig,
    authType: providerConfig.authType ?? "api_key",
    apiKey: undefined,
    hasApiKey: Boolean(providerConfig.apiKey),
    hasOAuth: Boolean(providerConfig.oauthCredential),
    baseUrl: providerConfig.baseUrl ?? undefined,
  };
}

export function serializeSession(session: Session | SessionWithMessages): Session {
  return {
    ...session,
    messages: session.messages.map((message, messageIndex) =>
      serializeMessageForDisplay(message, {
        sessionId: session.id,
        messageIndex,
      }),
    ),
    forkedFrom: session.forkedFrom ?? undefined,
    pinnedAt: session.pinnedAt ?? undefined,
  };
}

export function serializeSessionMetadata(
  session: typeof sessions.$inferSelect,
  messageCount: number,
): SessionMetadata {
  return {
    id: session.id,
    title: session.title,
    userId: session.userId,
    agentId: session.agentId,
    modelRefId: session.modelRefId,
    thinkingLevel: session.thinkingLevel,
    forkedFrom: session.forkedFrom ?? undefined,
    pinnedAt: session.pinnedAt ?? undefined,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount,
  };
}

const MAX_TOOL_RESULT_TEXT_LENGTH = 8_000;
const MAX_STRING_VALUE_LENGTH = 1_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 30;

type MessageDisplayContext = {
  sessionId: string;
  messageIndex: number;
};

function serializeMessageForDisplay(message: AgentMessage, context: MessageDisplayContext): AgentMessage {
  if (!isRecord(message) || typeof message.role !== "string") return message;
  const role = (message as { role?: string }).role;
  const record = message as Record<string, unknown>;

  if (role === "user" || role === "user-with-attachments") {
    return {
      ...message,
      content: serializeUserContent(record.content, context),
      attachments: Array.isArray(record.attachments)
        ? record.attachments.map((attachment) => serializeAttachmentForDisplay(attachment, context))
        : record.attachments,
    } as unknown as AgentMessage;
  }

  if (role === "assistant") {
    return {
      ...message,
      responseId: undefined,
      diagnostics: undefined,
      content: Array.isArray(record.content)
        ? serializeAssistantContent(record.content, context)
        : message.content,
    } as unknown as AgentMessage;
  }

  if (role === "toolResult") {
    return {
      ...message,
      content: Array.isArray(record.content)
        ? record.content.map((part, partIndex) => serializeToolResultContentPart(part, context, partIndex)).filter(Boolean)
        : record.content,
      details: summarizeValue(record.details),
    } as unknown as AgentMessage;
  }

  return message;
}

function serializeUserContent(content: unknown, context: MessageDisplayContext) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  let imageIndex = 0;
  return content.flatMap((part) => {
    if (!isRecord(part) || typeof part.type !== "string") return [];
    if (part.type === "text") return [{ ...part, text: String(part.text ?? "") }];
    if (part.type === "image") {
      const currentImageIndex = imageIndex++;
      return [
        {
          type: "image",
          mimeType: String(part.mimeType ?? "image/png"),
          url: sessionImageUrl(context.sessionId, context.messageIndex, currentImageIndex),
        },
      ];
    }
    return [part];
  });
}

function serializeAssistantContent(content: unknown[], context: MessageDisplayContext) {
  let imageIndex = 0;
  return content.flatMap((part) => {
    if (isRecord(part) && part.type === "image") {
      const currentImageIndex = imageIndex++;
      return [
        {
          type: "image",
          mimeType: String(part.mimeType ?? "image/png"),
          url: sessionImageUrl(context.sessionId, context.messageIndex, currentImageIndex),
        },
      ];
    }
    const serialized = serializeAssistantContentPart(part);
    return serialized ? [serialized] : [];
  });
}

function serializeAssistantContentPart(part: unknown) {
  if (!isRecord(part) || typeof part.type !== "string") return undefined;
  if (part.type === "text") return { ...part, text: String(part.text ?? "") };
  if (part.type === "thinking") {
    return {
      type: "thinking",
      thinking: String(part.thinking ?? ""),
      redacted: part.redacted === true ? true : undefined,
    };
  }
  if (part.type === "toolCall") {
    const name = typeof part.name === "string" ? part.name : "tool";
    return {
      type: "toolCall",
      id: typeof part.id === "string" ? part.id : "",
      name,
      arguments: summarizeValue(part.arguments),
    };
  }
  return part;
}

function serializeToolResultContentPart(part: unknown, context: MessageDisplayContext, partIndex: number) {
  if (!isRecord(part) || typeof part.type !== "string") return undefined;
  if (part.type === "text") return { ...part, text: truncateText(String(part.text ?? ""), MAX_TOOL_RESULT_TEXT_LENGTH) };
  if (part.type === "image") {
    return {
      type: "image",
      mimeType: String(part.mimeType ?? "image/png"),
      url: sessionToolResultImageUrl(context.sessionId, context.messageIndex, partIndex),
    };
  }
  return part;
}

function serializeAttachmentForDisplay(attachment: unknown, context: MessageDisplayContext) {
  if (!isRecord(attachment)) return attachment;
  const id = typeof attachment.id === "string" ? attachment.id : "";
  const type = typeof attachment.type === "string" ? attachment.type : undefined;
  return {
    id: attachment.id,
    type,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    url:
      type === "image" && id
        ? sessionAttachmentUrl(context.sessionId, context.messageIndex, id)
        : undefined,
  };
}

function sessionImageUrl(sessionId: string, messageIndex: number, imageIndex: number) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${messageIndex}/${imageIndex}`;
}

function sessionToolResultImageUrl(sessionId: string, messageIndex: number, partIndex: number) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/tool-result-images/${messageIndex}/${partIndex}`;
}

function sessionAttachmentUrl(sessionId: string, messageIndex: number, attachmentId: string) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${messageIndex}/${encodeURIComponent(attachmentId)}`;
}

function summarizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateText(value, MAX_STRING_VALUE_LENGTH);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 3) return "[Object omitted]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => summarizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`... ${value.length - MAX_ARRAY_ITEMS} more items`);
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = summarizeValue(item, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) result.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
  return result;
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[Truncated ${text.length - maxLength} characters for display]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
