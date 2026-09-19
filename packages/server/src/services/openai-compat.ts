import { randomUUID } from "node:crypto";
import {
  clampThinkingLevel,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingLevel,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { z } from "zod";

/**
 * Translation between the OpenAI Chat Completions wire format and pi-ai.
 *
 * The `/v1` endpoint is a pass-through: tools are the caller's, so Carmel never
 * executes a tool call here -- it reports it back as `tool_calls` and the caller
 * answers with a `tool` message on its next request, exactly as it would with
 * OpenAI. Everything provider-facing (auth, User-Agent, attribution headers,
 * request shape) is pi-ai's, because the request goes out through the same
 * ModelRuntime a Carmel run uses.
 */

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const imagePartSchema = z
  .object({
    type: z.literal("image_url"),
    image_url: z.union([z.string(), z.object({ url: z.string() }).passthrough()]),
  })
  .passthrough();
const refusalPartSchema = z.object({ type: z.literal("refusal"), refusal: z.string() }).passthrough();
const textContentSchema = z.union([z.string(), z.array(textPartSchema)]).nullish();

const toolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal("function").optional(),
    function: z.object({ name: z.string(), arguments: z.string().optional() }).passthrough(),
  })
  .passthrough();

const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: textContentSchema }).passthrough(),
  z.object({ role: z.literal("developer"), content: textContentSchema }).passthrough(),
  z
    .object({
      role: z.literal("user"),
      content: z.union([z.string(), z.array(z.union([textPartSchema, imagePartSchema]))]),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.union([z.string(), z.array(z.union([textPartSchema, refusalPartSchema]))]).nullish(),
      tool_calls: z.array(toolCallSchema).nullish(),
    })
    .passthrough(),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: textContentSchema }).passthrough(),
]);

const toolSchema = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        strict: z.boolean().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().nullish(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullish(),
    tools: z.array(toolSchema).nullish(),
    tool_choice: z
      .union([z.enum(["auto", "none", "required"]), z.object({ type: z.literal("function") }).passthrough()])
      .nullish(),
    temperature: z.number().nullish(),
    top_p: z.number().nullish(),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
    reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
    n: z.number().int().nullish(),
    response_format: z.object({ type: z.string() }).passthrough().nullish(),
    user: z.string().nullish(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

export class OpenAICompatError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
    readonly code = "invalid_request_error",
  ) {
    super(message);
  }
}

/**
 * Replayed assistant turns come from the caller, not from a pi response, so
 * they are labelled as a different model on purpose. That is what makes pi's
 * `transformMessages` treat them as foreign: tool-call IDs get normalized for
 * the target provider (Anthropic rejects OpenAI's `call_...|...` IDs) instead of
 * being replayed as if the provider had minted them.
 */
const REPLAY_ORIGIN = { api: "openai-completions", provider: "openai-compat-client", model: "client-history" } as const;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function toPiContext(request: ChatCompletionRequest): Context {
  if ((request.n ?? 1) !== 1) throw new OpenAICompatError("Only n=1 is supported.");
  if (request.response_format && request.response_format.type !== "text") {
    throw new OpenAICompatError(`response_format "${request.response_format.type}" is not supported.`);
  }

  const systemParts: string[] = [];
  const messages: Message[] = [];
  // Tool results name their tool in pi but only reference a call ID in OpenAI.
  const toolNames = new Map<string, string>();
  const timestamp = Date.now();

  for (const message of request.messages) {
    switch (message.role) {
      case "system":
      case "developer": {
        // pi has one system prompt. A mid-conversation system message is still
        // an instruction, so it joins the prompt rather than being dropped.
        const text = joinText(message.content);
        if (text) systemParts.push(text);
        break;
      }
      case "user":
        messages.push({ role: "user", content: toUserContent(message.content), timestamp });
        break;
      case "assistant": {
        const content: AssistantMessage["content"] = [];
        const text =
          typeof message.content === "string"
            ? message.content
            : (message.content ?? []).map((part) => ("text" in part ? part.text : part.refusal)).join("");
        if (text) content.push({ type: "text", text });
        for (const call of message.tool_calls ?? []) {
          toolNames.set(call.id, call.function.name);
          content.push({
            type: "toolCall",
            id: call.id,
            name: call.function.name,
            arguments: parseToolArguments(call.function.arguments),
          });
        }
        messages.push({
          role: "assistant",
          content,
          ...REPLAY_ORIGIN,
          usage: EMPTY_USAGE,
          stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
          timestamp,
        });
        break;
      }
      case "tool":
        messages.push({
          role: "toolResult",
          toolCallId: message.tool_call_id,
          toolName: toolNames.get(message.tool_call_id) ?? "",
          content: [{ type: "text", text: joinText(message.content) }],
          isError: false,
          timestamp,
        });
        break;
    }
  }

  const tools: Tool[] | undefined = request.tools?.map(({ function: fn }) => ({
    name: fn.name,
    description: fn.description ?? "",
    // Passed through untouched: the caller's JSON Schema is what the provider
    // should see. pi types this as a TypeBox schema, which is plain JSON Schema.
    parameters: (fn.parameters ?? { type: "object", properties: {} }) as Tool["parameters"],
  }));

  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
  };
}

/** The per-request options pi takes from the caller. Auth and headers are deliberately not among them. */
export function toPiStreamOptions(request: ChatCompletionRequest, model: Model<Api>): SimpleStreamOptions {
  const options: SimpleStreamOptions = {};
  if (request.temperature != null) options.temperature = request.temperature;
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  if (maxTokens != null) options.maxTokens = maxTokens;
  if (request.top_p != null) options.samplingParams = { top_p: request.top_p };

  // pi's tool choice is auto|none. "required" and a named function have no
  // provider-neutral equivalent, so they degrade to auto: the tools are still
  // offered, the model just is not forced to call one.
  if (request.tool_choice === "none") options.toolChoice = "none";
  else if (request.tool_choice) options.toolChoice = "auto";

  if (request.reasoning_effort && request.reasoning_effort !== "none" && model.reasoning) {
    const level = clampThinkingLevel(model, request.reasoning_effort);
    if (level !== "off") options.reasoning = level as ThinkingLevel;
  }
  return options;
}

type ChunkEnvelope = { id: string; created: number; model: string };

/**
 * Stateful pi-event -> `chat.completion.chunk` translator for one response.
 * Returns zero or more chunks per event.
 */
export function createChunkTranslator(envelope: ChunkEnvelope, includeUsage: boolean) {
  const toolIndexByContent = new Map<number, number>();
  const argumentsSent = new Set<number>();
  let sentRole = false;

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: envelope.id,
    object: "chat.completion.chunk",
    created: envelope.created,
    model: envelope.model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  });

  const withRole = (delta: Record<string, unknown>) => {
    if (sentRole) return delta;
    sentRole = true;
    return { role: "assistant", ...delta };
  };

  /** The tool-call header (id, name) is sent once, as soon as the provider has named the call. */
  const toolHeader = (contentIndex: number, block: AssistantMessage["content"][number] | undefined) => {
    if (block?.type !== "toolCall" || !block.name) return undefined;
    if (toolIndexByContent.has(contentIndex)) return undefined;
    const index = toolIndexByContent.size;
    toolIndexByContent.set(contentIndex, index);
    return chunk(
      withRole({
        tool_calls: [
          { index, id: block.id || `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: block.name, arguments: "" } },
        ],
      }),
    );
  };

  return (event: AssistantMessageEvent): object[] => {
    switch (event.type) {
      case "start":
        return [chunk(withRole({ content: "" }))];
      case "text_delta":
        return event.delta ? [chunk(withRole({ content: event.delta }))] : [];
      case "thinking_delta":
        // `reasoning_content` is the field DeepSeek, vLLM and OpenRouter-style
        // clients read; OpenAI itself never streams reasoning text.
        return event.delta ? [chunk(withRole({ reasoning_content: event.delta }))] : [];
      case "toolcall_start": {
        const header = toolHeader(event.contentIndex, event.partial.content[event.contentIndex]);
        return header ? [header] : [];
      }
      case "toolcall_delta": {
        const out: object[] = [];
        const header = toolHeader(event.contentIndex, event.partial.content[event.contentIndex]);
        if (header) out.push(header);
        const index = toolIndexByContent.get(event.contentIndex);
        if (index !== undefined && event.delta) {
          argumentsSent.add(event.contentIndex);
          out.push(chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] }));
        }
        return out;
      }
      case "toolcall_end": {
        const out: object[] = [];
        const header = toolHeader(event.contentIndex, event.toolCall);
        if (header) out.push(header);
        const index = toolIndexByContent.get(event.contentIndex);
        // A provider that delivers a call whole (or whose deltas arrived before
        // the name did) still owes the caller its arguments.
        if (index !== undefined && !argumentsSent.has(event.contentIndex)) {
          argumentsSent.add(event.contentIndex);
          out.push(chunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(event.toolCall.arguments) } }] }));
        }
        return out;
      }
      case "done": {
        const out: object[] = [chunk({}, finishReason(event.message.stopReason))];
        if (includeUsage) {
          out.push({
            id: envelope.id,
            object: "chat.completion.chunk",
            created: envelope.created,
            model: envelope.model,
            choices: [],
            usage: toOpenAIUsage(event.message.usage),
          });
        }
        return out;
      }
      default:
        return [];
    }
  };
}

export function toChatCompletion(envelope: ChunkEnvelope, message: AssistantMessage) {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
  const reasoning = message.content
    .flatMap((block) => (block.type === "thinking" && !block.redacted ? [block.thinking] : []))
    .join("");
  const toolCalls = message.content.flatMap((block) =>
    block.type === "toolCall"
      ? [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.arguments) } }]
      : [],
  );
  return {
    id: envelope.id,
    object: "chat.completion",
    created: envelope.created,
    model: envelope.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (toolCalls.length > 0 ? null : ""),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          refusal: null,
        },
        logprobs: null,
        finish_reason: finishReason(message.stopReason),
      },
    ],
    usage: toOpenAIUsage(message.usage),
  };
}

export function toOpenAIError(message: string, type = "api_error", code: string | null = null) {
  return { error: { message, type, param: null, code } };
}

export function toOpenAIUsage(usage: Usage) {
  // OpenAI's prompt_tokens includes cached tokens; pi reports them separately.
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.output,
    total_tokens: promptTokens + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
    completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
  };
}

function finishReason(stopReason: StopReason) {
  switch (stopReason) {
    case "toolUse":
      return "tool_calls";
    case "length":
      return "length";
    default:
      return "stop";
  }
}

function joinText(content: string | Array<{ text: string }> | null | undefined) {
  if (!content) return "";
  return typeof content === "string" ? content : content.map((part) => part.text).join("");
}

function toUserContent(
  content: string | Array<z.infer<typeof textPartSchema> | z.infer<typeof imagePartSchema>>,
): string | (TextContent | ImageContent)[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
    return parseDataUrl(url);
  });
}

/**
 * Images must be inline. Fetching a caller-supplied URL would make this server
 * an open HTTP client for anyone holding a key, reaching whatever the host can.
 */
function parseDataUrl(url: string): ImageContent {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) throw new OpenAICompatError("Only base64 data: URLs are supported for image_url.");
  return { type: "image", mimeType: match[1]!, data: match[2]! };
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new OpenAICompatError("tool_calls[].function.arguments must be a JSON object.");
  }
}
