import { isRecord, toSessionMetadata } from "@carmel-agent/shared";
import type { AgentConfig, ModelRef, ProviderConfig, Session, SessionMetadata, User } from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { agents, modelRefs, providerConfigs, sessions, users } from "./db/schema.ts";
import { defaultAgentWorkingDir } from "./paths.ts";
import type { SessionWithMessages } from "./services/session-store.ts";
import { PENDING_ENTRY_ID_PREFIX } from "./services/pi-session-storage.ts";
import { resolveServerModelRef } from "./runtime/model.ts";

export function serializeUser(user: typeof users.$inferSelect): User {
  return {
    id: user.id,
    username: user.username ?? undefined,
    name: user.name,
    email: user.email,
    role: user.role ?? "user",
    fastTaskModelRefId: user.fastTaskModelRefId ?? undefined,
    hasPassword: Boolean(user.passwordHash),
  };
}

export function serializePublicAgent(agent: typeof agents.$inferSelect): AgentConfig {
  const settings = serializeAgentSettings(agent);
  return {
    ...settings,
    systemPrompt: "",
    promptTemplates: [],
    mcpServers: [],
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
  // Listed field by field on purpose: spreading the row leaks storage-only
  // columns (createdAt/updatedAt) that the strict command schema rejects when
  // the client echoes a model back on save.
  const serialized: ModelRef = {
    id: model.id,
    ownerUserId: model.ownerUserId,
    shared: model.shared,
    label: model.label,
    provider: model.provider,
    modelId: model.modelId,
    reasoning: model.reasoning,
    input: model.input,
    providerConfigId: model.providerConfigId ?? undefined,
    api: model.api ?? undefined,
    baseUrl: model.baseUrl ?? undefined,
    contextWindow: model.contextWindow ?? undefined,
    maxTokens: model.maxTokens ?? undefined,
    thinkingLevelMap: model.thinkingLevelMap ?? undefined,
  };
  const definition = resolveServerModelRef(serialized);
  return {
    ...serialized,
    api: serialized.api ?? definition.api,
    contextWindow: serialized.contextWindow ?? definition.contextWindow,
    maxTokens: serialized.maxTokens ?? definition.maxTokens,
    // Resolve against the catalog/defaults so existing Ollama rows (which
    // were stored before thinking metadata was discovered) gain reasoning
    // support when they are serialized again.
    reasoning: definition.reasoning,
    input: serialized.input ?? definition.input,
    // Without this the client rebuilds the model without a level map, and its
    // thinking selector silently caps at "high".
    thinkingLevelMap: definition.thinkingLevelMap,
  };
}

export function serializeProviderConfig(providerConfig: typeof providerConfigs.$inferSelect): ProviderConfig {
  // Listed field by field on purpose: spreading the row leaks the stored OAuth
  // credential to clients.
  return {
    id: providerConfig.id,
    userId: providerConfig.userId,
    label: providerConfig.label,
    provider: providerConfig.provider,
    authType: providerConfig.authType ?? "api_key",
    apiKey: undefined,
    hasApiKey: Boolean(providerConfig.apiKey),
    hasOAuth: Boolean(providerConfig.oauthCredential),
    baseUrl: providerConfig.baseUrl ?? undefined,
    createdAt: providerConfig.createdAt,
    updatedAt: providerConfig.updatedAt,
  };
}

export function serializeSession(session: Session | SessionWithMessages): Session {
  return {
    ...toSessionMetadata(session),
    messages: session.messages.map((message, messageIndex) =>
      serializeMessageForDisplay(message, {
        sessionId: session.id,
        entryId: session.messageEntryIds[messageIndex],
      }),
    ),
    messageEntryIds: session.messageEntryIds,
  };
}

export function serializeSessionMetadata(session: typeof sessions.$inferSelect): SessionMetadata {
  return toSessionMetadata(session);
}

const MAX_TOOL_RESULT_TEXT_LENGTH = 8_000;
const MAX_STRING_VALUE_LENGTH = 1_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 30;

type MessageDisplayContext = {
  sessionId: string;
  /**
   * Addresses the message's images. Entries are immutable -- an edit writes a
   * sibling -- so a URL built from one can be cached for good, where a position
   * in the transcript is reused by whatever lands there after a truncate.
   */
  entryId: string | undefined;
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
          url: sessionImageUrl(context, currentImageIndex),
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
          url: sessionImageUrl(context, currentImageIndex),
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
      url: sessionToolResultImageUrl(context, partIndex),
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
        ? sessionAttachmentUrl(context, id)
        : undefined,
  };
}

function sessionImageUrl(context: MessageDisplayContext, imageIndex: number) {
  return sessionEntryUrl(context, "images", String(imageIndex));
}

function sessionToolResultImageUrl(context: MessageDisplayContext, partIndex: number) {
  return sessionEntryUrl(context, "tool-result-images", String(partIndex));
}

function sessionAttachmentUrl(context: MessageDisplayContext, attachmentId: string) {
  return sessionEntryUrl(context, "attachments", attachmentId);
}

function sessionEntryUrl(context: MessageDisplayContext, kind: string, key: string) {
  // A pending entry is a reply still streaming; it gets a real id when it commits.
  if (!context.entryId || context.entryId.startsWith(PENDING_ENTRY_ID_PREFIX)) return undefined;
  return `/api/sessions/${encodeURIComponent(context.sessionId)}/${kind}/${encodeURIComponent(context.entryId)}/${encodeURIComponent(key)}`;
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
