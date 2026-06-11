import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { ChatAttachment } from "@carmel-agent/shared";

export type LocalChatAttachment = ChatAttachment;
export type DisplayImageContent = ImageContent & {
  data?: string;
  url?: string;
};

export function isUserMessage(message: AgentMessage) {
  return message.role === "user" || message.role === "user-with-attachments";
}

export function getMessageText(message: AgentMessage | AssistantMessage) {
  if (message.role === "assistant") {
    return message.content
      .filter(isTextContent)
      .map((part) => part.text)
      .join("\n\n")
      .trim();
  }

  if (!isUserMessage(message as AgentMessage)) return "";
  const content = (message as AgentMessage & { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isTextContent)
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

export function getMessageImages(message: AgentMessage): DisplayImageContent[] {
  const content = (message as AgentMessage & { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter(isImageContent);
}

export function getMessageAttachments(message: AgentMessage) {
  if (message.role !== "user-with-attachments") return [];
  return message.attachments ?? [];
}

export function updateUserMessageContent(message: AgentMessage, content: string): AgentMessage {
  if (!isUserMessage(message)) return message;
  if (typeof message.content === "string") return { ...message, content } as AgentMessage;

  let replacedText = false;
  const nextContent = message.content.map((part) => {
    if (part.type !== "text" || replacedText) return part;
    replacedText = true;
    return { ...part, text: content };
  });

  if (!replacedText) nextContent.unshift({ type: "text", text: content });
  return { ...message, content: nextContent } as AgentMessage;
}

export function findMessageIndex(messages: AgentMessage[], target: AgentMessage) {
  const referenceIndex = messages.indexOf(target);
  if (referenceIndex >= 0) return referenceIndex;

  return messages.findIndex(
    (message) =>
      message.role === target.role &&
      message.timestamp === target.timestamp &&
      JSON.stringify(getComparableMessageContent(message)) === JSON.stringify(getComparableMessageContent(target)),
  );
}

export function buildToolResultsById(messages: AgentMessage[]) {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }
  return results;
}

export function formatUsage(usage?: Usage) {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.input) parts.push(`in ${formatTokenCount(usage.input)}`);
  if (usage.output) parts.push(`out ${formatTokenCount(usage.output)}`);
  if (usage.cacheRead) parts.push(`read ${formatTokenCount(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`write ${formatTokenCount(usage.cacheWrite)}`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" ");
}

export function formatToolResult(result?: ToolResultMessage) {
  if (!result) return "(no result)";
  const text = result.content
    ?.map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return `[Image output: ${part.mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return summarize(text || "(no output)");
}

export function formatJson(value: unknown) {
  if (typeof value === "undefined") return "{}";
  try {
    return summarize(JSON.stringify(value, null, 2));
  } catch {
    return summarize(String(value));
  }
}

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  textArea.remove();
}

export async function fileToImageAttachment(file: File): Promise<LocalChatAttachment> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
  const dataUrl = await readFileAsDataUrl(file);
  const content = dataUrl.split(",", 2)[1] ?? "";
  return {
    id: `${file.name}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type: "image",
    fileName: file.name,
    mimeType: file.type || "image/png",
    size: file.size,
    content,
    preview: content,
  };
}

export function attachmentToImageContent(attachment: LocalChatAttachment): ImageContent {
  if (!attachment.content) throw new Error(`${attachment.fileName} has no image content.`);
  return {
    type: "image",
    data: attachment.content,
    mimeType: attachment.mimeType,
  };
}

export function parseSkillInvocation(text: string) {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return undefined;
  return {
    name: match[1],
    location: match[2],
    body: match[3],
    prompt: match[4],
  };
}

function isTextContent(content: unknown): content is TextContent {
  return typeof content === "object" && content !== null && (content as TextContent).type === "text";
}

function isImageContent(content: unknown): content is DisplayImageContent {
  return typeof content === "object" && content !== null && (content as ImageContent).type === "image";
}

function getComparableMessageContent(message: AgentMessage) {
  return "content" in message ? message.content : undefined;
}

function formatTokenCount(count: number) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

function summarize(text: string) {
  const max = 2_000;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Truncated ${text.length - max} characters for display]`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read file.")));
    reader.readAsDataURL(file);
  });
}
