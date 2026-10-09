import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export async function generateSessionTitle({
  model,
  modelRuntime,
  timeoutMs = 60_000,
  messages,
}: {
  model: Model<Api>;
  modelRuntime: Pick<Models, "completeSimple">;
  timeoutMs?: number;
  messages: AgentMessage[];
}) {
  const transcript = buildTitleTranscript(messages);
  if (!transcript) return undefined;

  const supportedThinkingLevels = getSupportedThinkingLevels(model);
  const titleThinkingLevel = getTitleThinkingLevel(model, supportedThinkingLevels);
  const maxTokens = titleThinkingLevel === "off" ? 64 : 1024;
  // Keep the model's reasoning metadata so Pi can send its configured off value.
  const response = await modelRuntime.completeSimple(
    model,
    {
      systemPrompt:
        "Generate a concise chat title. Return only the title, with no quotes, no markdown, and no punctuation suffix.",
      messages: [
        {
          role: "user",
          content: `Create a title of 3 to 7 words for this conversation:\n\n${transcript}`,
          timestamp: Date.now(),
        },
      ],
    },
    {
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
      maxTokens,
      reasoning: titleThinkingLevel === "off" ? undefined : titleThinkingLevel,
    },
  );
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || "Session title generation failed.");
  }

  return cleanSessionTitle(extractText(response));
}

function getTitleThinkingLevel(
  model: Model<Api>,
  supportedThinkingLevels: ModelThinkingLevel[],
): "off" | ThinkingLevel {
  if (supportedThinkingLevels.includes("off")) return "off";
  return clampThinkingLevel(model, "low") as ThinkingLevel;
}

export function shouldGenerateSessionTitle(title: string, messages: AgentMessage[]) {
  if (!isPlaceholderTitle(title)) return false;
  return (
    countUserMessages(messages) > 0 &&
    messages.some((message) => message.role === "assistant" && !message.errorMessage)
  );
}

function buildTitleTranscript(messages: AgentMessage[]) {
  const lines = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(0, 4)
    .map((message) => {
      const text = extractText(message);
      return text ? `${message.role === "user" ? "User" : "Assistant"}: ${text}` : "";
    })
    .filter(Boolean);
  return lines.join("\n").slice(0, 4000);
}

function extractText(message: AgentMessage) {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function cleanSessionTitle(title: string) {
  const cleaned = title
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。!！?？:：;；]+$/g, "");
  if (!cleaned) return undefined;
  return cleaned.length > 64 ? cleaned.slice(0, 64).trim() : cleaned;
}

function isPlaceholderTitle(title: string) {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === "untitled session" ||
    normalized === "new chat" ||
    normalized.startsWith("session_")
  );
}

function countUserMessages(messages: AgentMessage[]) {
  return messages.filter((message) => message.role === "user").length;
}
