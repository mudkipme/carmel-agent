import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { RemoteAgent } from "./remote-agent.ts";

const model = {
  id: "test-model",
  name: "Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} as Model<Api>;

test("a vanished reconnect stream refreshes and applies the authoritative transcript", async () => {
  const originalFetch = globalThis.fetch;
  const initial = [userMessage("stale")];
  const final = [userMessage("persisted final")];
  let refreshes = 0;
  let agent: RemoteAgent;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    agent = new RemoteAgent({
      agentId: "agent_1",
      sessionId: "session_1",
      modelRefId: "model_1",
      model,
      thinkingLevel: "off",
      messages: initial,
      onRunComplete: async () => {
        refreshes += 1;
        agent.setMessages(final);
      },
    });

    await agent.attachToRun("already_finished", initial);

    assert.equal(refreshes, 1);
    assert.deepEqual(agent.state.messages, final);
    assert.equal(agent.state.isStreaming, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream completion yields to the server-authoritative refresh", async () => {
  const originalFetch = globalThis.fetch;
  const streamed = assistantMessage("stream event");
  const final = [userMessage("question"), streamed, assistantMessage("persisted post-processing")];
  let agent: RemoteAgent;
  globalThis.fetch = async () =>
    new Response(
      `${JSON.stringify({ type: "message_end", message: streamed })}\n${JSON.stringify({ type: "agent_end", messages: [streamed] })}\n`,
      { status: 200 },
    );
  try {
    agent = new RemoteAgent({
      agentId: "agent_1",
      sessionId: "session_1",
      modelRefId: "model_1",
      model,
      thinkingLevel: "off",
      messages: [userMessage("question")],
      onRunComplete: async () => agent.setMessages(final),
    });

    await agent.attachToRun("active_run");

    assert.deepEqual(agent.state.messages, final);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed authority refresh is not turned into a synthetic model failure", async () => {
  const originalFetch = globalThis.fetch;
  const initial = [userMessage("still persisted")];
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const agent = new RemoteAgent({
      agentId: "agent_1",
      sessionId: "session_1",
      modelRefId: "model_1",
      model,
      thinkingLevel: "off",
      messages: initial,
      onRunComplete: async () => {
        throw new Error("refresh unavailable");
      },
    });

    await agent.attachToRun("already_finished", initial);

    assert.deepEqual(agent.state.messages, initial);
    assert.equal(agent.state.errorMessage, "refresh unavailable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function userMessage(content: string): AgentMessage {
  return { role: "user", content } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
