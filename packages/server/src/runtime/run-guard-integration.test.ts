import test from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { attachTestHarness } from "../effectors/testing/pi-harness.ts";
import { RunGuard } from "../effectors/run-guard.ts";
import { HarnessAbortGate } from "./agent-runtime.ts";

initialize();

test("a model that never stops calling tools is stopped at the ceiling", async () => {
  // Pi's agent loop has no iteration cap, so without the guard this prompt does
  // not return. The faux model asks for the same tool every turn.
  const { sessionId } = createSession();
  const faux = fauxProvider({ provider: `faux-guard-${crypto.randomUUID()}`, tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 50 }, () => () => fauxAssistantMessage([fauxToolCall("spin", {})], { stopReason: "toolUse" })) as never,
  );

  const piSession = await openPiSession(sessionId);
  let executions = 0;
  const pi = await attachTestHarness(piSession, {
    models,
    model: faux.getModel(),
    systemPrompt: "Test assistant",
    tools: [
      {
        name: "spin",
        label: "Spin",
        description: "Does nothing, forever.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          executions += 1;
          return { content: [{ type: "text", text: "spun" }] };
        },
      } as never,
    ],
  });
  const { lane, context } = pi;

  const guard = new RunGuard({ maxToolCalls: 4, stallTimeoutMs: 60_000 });
  const abort = new HarnessAbortGate();
  abort.attach(lane);
  const unsubscribe = pi.observe((event) => {
    const stop = event.type === "tool_end" ? guard.recordToolCall() : (guard.recordActivity(), undefined);
    if (stop) abort.request();
  });

  try {
    await lane.prompt("spin forever", undefined, context);

    assert.equal(guard.stop?.reason, "tool_ceiling");
    // One past the ceiling trips it, and the run must not carry on afterwards.
    assert.equal(guard.toolCalls, 5);
    assert.ok(executions <= 6, `tool ran ${executions} times`);

    // The branch stays promptable: Pi synthesizes results for tool calls that
    // were pending when the abort landed, so the guard cannot strand one.
    const branch = await pi.branch();
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const message = entry.message as { role: string; content?: unknown; toolCallId?: string };
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          const call = part as { type?: string; id?: string };
          if (call.type === "toolCall" && call.id) calls.add(call.id);
        }
      }
      if (message.role === "toolResult" && message.toolCallId) results.add(message.toolCallId);
    }
    assert.deepEqual([...calls].filter((id) => !results.has(id)), [], "guard abort left an unanswered tool call");
  } finally {
    unsubscribe();
    await pi.close();
  }
});
