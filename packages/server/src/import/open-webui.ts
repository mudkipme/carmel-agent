import type { ModelRef, Session } from "@carmel-agent/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Provider, TextContent, Usage } from "@earendil-works/pi-ai";
import { id } from "../db/seed.ts";

type OpenWebuiImportOptions = Pick<Session, "userId" | "agentId" | "modelRefId" | "thinkingLevel"> & {
  modelRef: Pick<ModelRef, "provider" | "modelId" | "api">;
  now: number;
};

type OpenWebuiImportResult = {
  sessions: Session[];
  skipped: number;
};

type OpenWebuiMessage = {
  id?: unknown;
  parentId?: unknown;
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  usage?: unknown;
  model?: unknown;
  modelName?: unknown;
  output?: unknown;
  files?: unknown;
};

export function importOpenWebuiSessions(source: unknown, options: OpenWebuiImportOptions): OpenWebuiImportResult {
  const chats = extractChats(source);
  const sessions = chats.flatMap((chat) => {
    const messages = extractMessages(chat);
    const convertedMessages = convertMessages(messages, options);
    if (convertedMessages.length === 0) return [];

    const createdAt =
      timestampFrom(readRecordValue(chat, "created_at")) ?? firstTimestamp(convertedMessages) ?? options.now;
    const updatedAt =
      timestampFrom(readRecordValue(chat, "updated_at")) ?? lastTimestamp(convertedMessages) ?? createdAt;
    return [
      {
        id: id("session"),
        title: readTitle(chat) ?? "Imported Open WebUI chat",
        userId: options.userId,
        agentId: options.agentId,
        modelRefId: options.modelRefId,
        thinkingLevel: options.thinkingLevel,
        messages: convertedMessages,
        createdAt,
        updatedAt,
      } satisfies Session,
    ];
  });

  return { sessions, skipped: chats.length - sessions.length };
}

function extractChats(source: unknown): Record<string, unknown>[] {
  if (Array.isArray(source)) return source.filter(isRecord);
  if (!isRecord(source)) return [];
  const chats = source.chats ?? source.data ?? source.items;
  if (Array.isArray(chats)) return chats.filter(isRecord);
  return looksLikeChat(source) ? [source] : [];
}

function looksLikeChat(value: Record<string, unknown>) {
  return isRecord(value.chat) || Array.isArray(value.messages) || isRecord(value.history);
}

function extractMessages(chatExport: Record<string, unknown>): OpenWebuiMessage[] {
  const chat = isRecord(chatExport.chat) ? chatExport.chat : chatExport;
  const history = isRecord(chat.history) ? chat.history : undefined;
  const historyMessages = isRecord(history?.messages) ? history.messages : undefined;
  const currentId = typeof history?.currentId === "string" ? history.currentId : undefined;
  const branchMessages = historyMessages && currentId ? messagesFromCurrentBranch(historyMessages, currentId) : [];
  if (branchMessages.length > 0) return branchMessages;

  const messages = Array.isArray(chat.messages)
    ? chat.messages
    : Array.isArray(chatExport.messages)
      ? chatExport.messages
      : [];
  return messages.filter(isRecord);
}

function messagesFromCurrentBranch(messages: Record<string, unknown>, currentId: string): OpenWebuiMessage[] {
  const branch: OpenWebuiMessage[] = [];
  const seen = new Set<string>();
  let nextId: string | undefined = currentId;
  while (nextId && !seen.has(nextId)) {
    seen.add(nextId);
    const message: unknown = messages[nextId];
    if (!isRecord(message)) break;
    branch.push(message);
    nextId = typeof message.parentId === "string" ? message.parentId : undefined;
  }
  return branch.reverse();
}

function convertMessages(messages: OpenWebuiMessage[], options: OpenWebuiImportOptions): AgentMessage[] {
  const converted: AgentMessage[] = [];
  messages.forEach((message, index) => {
    const role = typeof message.role === "string" ? message.role : "";
    const timestamp = timestampFrom(message.timestamp) ?? options.now + index;

    if (role === "user") {
      const text = contentToText(message.content);
      const images = extractImages(message.files);
      if (!text.trim() && images.length === 0) return;
      const content =
        images.length > 0
          ? [...(text.trim() ? [{ type: "text", text } satisfies TextContent] : []), ...images]
          : text;
      converted.push({ role: "user", content, timestamp });
      return;
    }
    if (role === "assistant") {
      const content = extractAssistantContent(message);
      if (!content.text.trim() && !content.thinking?.trim()) return;
      const contentParts: AssistantMessage["content"] = [];
      if (content.thinking?.trim()) contentParts.push({ type: "thinking", thinking: content.thinking });
      if (content.text.trim()) contentParts.push({ type: "text", text: content.text });
      converted.push({
        role: "assistant",
        content: contentParts,
        api: (options.modelRef.api ?? "openai-completions") as Api,
        provider: options.modelRef.provider as Provider,
        model: readModelName(message) ?? options.modelRef.modelId,
        usage: convertUsage(message.usage),
        stopReason: "stop",
        timestamp,
      } satisfies AssistantMessage);
    }
  });
  return converted;
}

function extractAssistantContent(message: OpenWebuiMessage) {
  const structured = outputToAssistantContent(message.output);
  if (structured.text || structured.thinking) return structured;
  return splitReasoningDetails(contentToText(message.content));
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        if (typeof part.value === "string") return part.value;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(content)) {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

function extractImages(files: unknown): ImageContent[] {
  if (!Array.isArray(files)) return [];
  const images: ImageContent[] = [];
  for (const file of files) {
    if (!isRecord(file) || file.type !== "image") continue;
    const url = readString(file.url) ?? readString(file.data);
    const image = url ? dataUrlToImageContent(url) : undefined;
    if (image) images.push(image);
  }
  return images;
}

function dataUrlToImageContent(url: string): ImageContent | undefined {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(url.trim());
  if (!match) return undefined;
  const data = match[2];
  if (!data) return undefined;
  return { type: "image", data, mimeType: match[1] || "image/png" };
}

function outputToAssistantContent(output: unknown): { text: string; thinking?: string } {
  if (!Array.isArray(output)) return { text: "" };
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const target = item.type === "reasoning" ? thinkingParts : textParts;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") continue;
      target.push(part.text);
    }
  }
  return { text: textParts.join("\n\n").trim(), thinking: thinkingParts.join("\n\n").trim() || undefined };
}

function splitReasoningDetails(content: string): { text: string; thinking?: string } {
  const thinkingParts: string[] = [];
  const text = content
    .replace(/<details\b(?=[^>]*\btype=["']reasoning["'])[^>]*>[\s\S]*?<\/details>/gi, (details) => {
      const thinking = cleanReasoningDetails(details);
      if (thinking) thinkingParts.push(thinking);
      return "";
    })
    .trim();
  return { text, thinking: thinkingParts.join("\n\n").trim() || undefined };
}

function cleanReasoningDetails(details: string) {
  return decodeHtmlEntities(
    details
      .replace(/^<details\b[^>]*>/i, "")
      .replace(/<\/details>$/i, "")
      .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, "")
      .replace(/<[^>]+>/g, "")
      .trim(),
  )
    .replace(/^>\s?/gm, "")
    .trim();
}

function decodeHtmlEntities(text: string) {
  return text.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (entity, value: string) => {
    const normalized = value.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos" || normalized === "#39") return "'";
    if (normalized.startsWith("#x")) return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    if (normalized.startsWith("#")) return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    return entity;
  });
}

function convertUsage(usage: unknown): Usage {
  if (!isRecord(usage)) return emptyUsage();
  const input = numberValue(usage.prompt_tokens);
  const output = numberValue(usage.completion_tokens);
  const totalTokens = numberValue(usage.total_tokens) || input + output;
  const cacheRead = isRecord(usage.prompt_tokens_details)
    ? numberValue(usage.prompt_tokens_details.cached_tokens)
    : 0;
  const cacheWrite = isRecord(usage.prompt_tokens_details)
    ? numberValue(usage.prompt_tokens_details.cache_write_tokens)
    : 0;
  const totalCost = numberValue(usage.cost);
  const costDetails = isRecord(usage.cost_details) ? usage.cost_details : {};
  const inputCost = numberValue(costDetails.upstream_inference_prompt_cost);
  const outputCost = numberValue(costDetails.upstream_inference_completions_cost);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: 0,
      cacheWrite: 0,
      total: totalCost || inputCost + outputCost,
    },
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function readTitle(chatExport: Record<string, unknown>) {
  const chat = isRecord(chatExport.chat) ? chatExport.chat : undefined;
  const title = readString(chatExport.title) ?? readString(chat?.title);
  return title?.trim() ? title.trim().slice(0, 160) : undefined;
}

function readModelName(message: OpenWebuiMessage) {
  return readString(message.modelName) ?? readString(message.model);
}

function readRecordValue(record: Record<string, unknown>, key: string) {
  return record[key] ?? (isRecord(record.chat) ? record.chat[key] : undefined);
}

function firstTimestamp(messages: AgentMessage[]) {
  for (const message of messages) {
    if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  }
  return undefined;
}

function lastTimestamp(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const timestamp = messages[index].timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

function timestampFrom(value: unknown) {
  const raw = numberValue(value);
  if (!raw) return undefined;
  return raw < 10_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
