import test from "node:test";
import assert from "node:assert/strict";
import { importOpenWebuiSessions } from "./open-webui.ts";
import type { ModelRef } from "@carmel-agent/shared";

const modelRef: Pick<ModelRef, "provider" | "modelId" | "api"> = {
  provider: "openai",
  modelId: "gpt-4.1",
  api: "openai-completions",
};

test("imports the current Open WebUI history branch", () => {
  const result = importOpenWebuiSessions(
    [
      {
        title: "Branch chat",
        created_at: 1_700_000_000,
        updated_at: 1_700_000_010,
        chat: {
          history: {
            currentId: "assistant_2",
            messages: {
              user_1: { id: "user_1", role: "user", content: "hello", timestamp: 1_700_000_001 },
              assistant_1: {
                id: "assistant_1",
                parentId: "user_1",
                role: "assistant",
                content: "wrong branch",
                timestamp: 1_700_000_002,
              },
              user_2: { id: "user_2", parentId: "user_1", role: "user", content: "use this", timestamp: 1_700_000_003 },
              assistant_2: {
                id: "assistant_2",
                parentId: "user_2",
                role: "assistant",
                content: "done",
                timestamp: 1_700_000_004,
              },
            },
          },
          messages: [{ role: "user", content: "flat fallback only" }],
        },
      },
    ],
    options(),
  );

  assert.equal(result.skipped, 0);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.title, "Branch chat");
  assert.deepEqual(
    result.sessions[0]?.messages.map((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? { role: message.role, content: message.content[0]?.type === "text" ? message.content[0].text : "" }
        : { role: message.role, content: "content" in message ? message.content : "" },
    ),
    [
      { role: "user", content: "hello" },
      { role: "user", content: "use this" },
      { role: "assistant", content: "done" },
    ],
  );
});

test("falls back to flat Open WebUI messages", () => {
  const result = importOpenWebuiSessions(
    {
      chat: {
        title: "Flat chat",
        messages: [
          { role: "system", content: "ignored" },
          { role: "user", content: [{ type: "text", text: "question" }] },
          {
            role: "assistant",
            content: "",
            output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.03 },
          },
        ],
      },
    },
    options(),
  );

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.messages.length, 2);
  const assistant = result.sessions[0]?.messages[1];
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.role === "assistant" ? assistant.usage.totalTokens : undefined, 15);
});

test("converts Open WebUI reasoning details to thinking content", () => {
  const result = importOpenWebuiSessions(
    {
      chat: {
        title: "Thinking chat",
        messages: [
          { role: "user", content: "question" },
          {
            role: "assistant",
            content:
              "<details type=\"reasoning\" done=\"true\"><summary>Thought</summary>&gt; hidden idea\n&gt; more</details>\nvisible answer",
          },
        ],
      },
    },
    options(),
  );

  const assistant = result.sessions[0]?.messages[1];
  assert.equal(assistant?.role, "assistant");
  assert.deepEqual(assistant?.role === "assistant" ? assistant.content : undefined, [
    { type: "thinking", thinking: "hidden idea\nmore" },
    { type: "text", text: "visible answer" },
  ]);
});

test("prefers structured Open WebUI output reasoning over HTML content", () => {
  const result = importOpenWebuiSessions(
    {
      chat: {
        title: "Structured thinking chat",
        messages: [
          { role: "user", content: "question" },
          {
            role: "assistant",
            content: "<details type=\"reasoning\"><summary>Thought</summary>html reasoning</details>\nhtml answer",
            output: [
              { type: "reasoning", content: [{ type: "output_text", text: "structured reasoning" }] },
              { type: "message", content: [{ type: "output_text", text: "structured answer" }] },
            ],
          },
        ],
      },
    },
    options(),
  );

  const assistant = result.sessions[0]?.messages[1];
  assert.equal(assistant?.role, "assistant");
  assert.deepEqual(assistant?.role === "assistant" ? assistant.content : undefined, [
    { type: "thinking", thinking: "structured reasoning" },
    { type: "text", text: "structured answer" },
  ]);
});

function options() {
  return {
    userId: "user_1",
    agentId: "agent_1",
    modelRefId: "model_1",
    thinkingLevel: "off" as const,
    modelRef,
    now: 1_700_000_000_000,
  };
}
