import type { AgentConfig, ModelRef, ProviderConfig, Session, SessionMetadata, User } from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { agents, modelRefs, providerConfigs, sessions, users } from "./db/schema.ts";
import { defaultAgentWorkingDir } from "./paths.ts";

export function serializeUser(user: typeof users.$inferSelect): User {
  return {
    id: user.id,
    username: user.username ?? undefined,
    name: user.name,
    email: user.email,
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
    customHeaders: undefined,
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
    customHeaders: undefined,
  };
}

export function serializeSession(session: Session | typeof sessions.$inferSelect): Session {
  return {
    ...session,
    messages: session.messages.map(serializeMessageForDisplay),
    forkedFrom: session.forkedFrom ?? undefined,
    pinnedAt: session.pinnedAt ?? undefined,
  };
}

export function serializeSessionMetadata(session: Session | typeof sessions.$inferSelect): SessionMetadata {
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
    messageCount: session.messages.length,
  };
}

const MAX_TOOL_RESULT_TEXT_LENGTH = 8_000;
const MAX_STRING_VALUE_LENGTH = 1_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 30;

function serializeMessageForDisplay(message: AgentMessage): AgentMessage {
  if (!isRecord(message) || typeof message.role !== "string") return message;
  const role = (message as { role?: string }).role;

  if (role === "user" || role === "user-with-attachments") {
    return {
      ...message,
      content: serializeUserContent(message.content),
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map(serializeAttachmentForDisplay)
        : message.attachments,
    } as unknown as AgentMessage;
  }

  if (role === "assistant") {
    return {
      ...message,
      responseId: undefined,
      diagnostics: undefined,
      content: Array.isArray(message.content)
        ? message.content.map(serializeAssistantContentPart).filter(Boolean)
        : message.content,
    } as unknown as AgentMessage;
  }

  if (role === "toolResult") {
    return {
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map(serializeToolResultContentPart).filter(Boolean)
        : message.content,
      details: summarizeValue(message.details),
    } as unknown as AgentMessage;
  }

  return message;
}

function serializeUserContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.flatMap((part) => {
    if (!isRecord(part) || typeof part.type !== "string") return [];
    if (part.type === "text") return [{ ...part, text: String(part.text ?? "") }];
    if (part.type === "image") return [{ type: "text", text: `[Image omitted from session payload: ${String(part.mimeType ?? "image")}]` }];
    return [part];
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
      arguments: name === "artifacts" ? part.arguments : summarizeValue(part.arguments),
    };
  }
  return part;
}

function serializeToolResultContentPart(part: unknown) {
  if (!isRecord(part) || typeof part.type !== "string") return undefined;
  if (part.type === "text") return { ...part, text: truncateText(String(part.text ?? ""), MAX_TOOL_RESULT_TEXT_LENGTH) };
  if (part.type === "image") return { type: "text", text: `[Image output omitted from session payload: ${String(part.mimeType ?? "image")}]` };
  return part;
}

function serializeAttachmentForDisplay(attachment: unknown) {
  if (!isRecord(attachment)) return attachment;
  return {
    id: attachment.id,
    type: attachment.type,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
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
