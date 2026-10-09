import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  chatCompletionRequestSchema,
  createChunkTranslator,
  toPiContext,
} from "./openai-compat.ts";

const envelope = { id: "chatcmpl-1", created: 0, model: "m" };

function partial(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "google-generative-ai",
    provider: "google",
    model: "g",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

test("a tool call that arrives whole still reaches the caller with its arguments", () => {
  const translate = createChunkTranslator(envelope, false);
  const toolCall = { type: "toolCall" as const, id: "", name: "lookup", arguments: { q: "x" } };
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: partial([]) },
    { type: "toolcall_start", contentIndex: 0, partial: partial([toolCall]) },
    { type: "toolcall_end", contentIndex: 0, toolCall, partial: partial([toolCall]) },
  ];
  const deltas = events
    .flatMap(translate)
    .flatMap((chunk: any) => chunk.choices[0].delta.tool_calls ?? []);
  assert.equal(deltas[0].function.name, "lookup");
  // Some providers mint no call ID; the caller still needs one to answer with.
  assert.match(deltas[0].id, /^call_/);
  assert.deepEqual(JSON.parse(deltas.map((delta: any) => delta.function.arguments).join("")), {
    q: "x",
  });
});

test("system and developer messages join into pi's single system prompt", () => {
  const context = toPiContext(
    chatCompletionRequestSchema.parse({
      model: "m",
      messages: [
        { role: "system", content: "One." },
        { role: "user", content: "hi" },
        { role: "developer", content: [{ type: "text", text: "Two." }] },
      ],
    }),
  );
  assert.equal(context.systemPrompt, "One.\n\nTwo.");
  assert.deepEqual(
    context.messages.map((message) => message.role),
    ["user"],
  );
});

test("replayed assistant turns are marked foreign so pi normalizes their tool-call IDs", () => {
  const context = toPiContext(
    chatCompletionRequestSchema.parse({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_1|abc", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1|abc", content: "ok" },
      ],
    }),
  );
  const assistant = context.messages[1] as AssistantMessage;
  assert.equal(assistant.provider, "openai-compat-client");
  const result = context.messages[2]!;
  assert.equal(result.role === "toolResult" && result.toolName, "f");
});
