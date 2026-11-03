import test from "node:test";
import assert from "node:assert/strict";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { applyRunProgress, type RunProgress, type AgentRunEvent } from "@carmel-agent/shared";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { openTestHarness } from "../effectors/testing/pi-harness.ts";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { classifyTurnFailure } from "../effectors/failure-classifier.ts";
import { isOverflowMessage, projectRunEvent, classifyAssistantFailure } from "./run-events.ts";

initialize();

function state(docs: ConversationView["docs"], ops: readonly Op[]) {
  return { type: "state" as const, value: { docs } as ConversationView, ops };
}

test("native live deltas retain text, thinking, tool arguments, and bounded nested output", () => {
  const message = fauxAssistantMessage([fauxThinking("hmm"), fauxText("Hello")]);
  const initial = projectRunEvent(
    state({ "pi.live": { generation: { attempt: 1, message } } } as never, [["r", {}]]),
  )!;
  let progress: RunProgress = {};
  progress = applyRunProgress(progress, initial);
  const ops: Op[] = [
    ["a", ["docs", "pi.live", "generation", "message", "content", 0, "thinking"], " more"],
    ["a", ["docs", "pi.live", "generation", "message", "content", 1, "text"], " world"],
    [
      "s",
      ["docs", "pi.live", "tools"],
      [{ callId: "parent", name: "codemode", status: "running" }],
    ],
    [
      "s",
      ["docs", "pi.live", "nestedTools"],
      [
        {
          callId: "parent/c1",
          name: "read",
          parentCallId: "parent",
          parentTaskId: 1,
          taskId: 2,
          arguments: {},
          status: "running",
          output: "old",
        },
      ],
    ],
    ["t", ["docs", "pi.live", "nestedTools", 0, "output"], 1],
    ["a", ["docs", "pi.live", "nestedTools", 0, "output"], "!"],
    ["s", ["docs", "pi.agent"], { private: true }],
  ];
  const projected = projectRunEvent(state({}, ops))!;
  const before = progress;
  progress = applyRunProgress(progress, projected);
  assert.deepEqual((progress.live?.generation?.message as AssistantMessage | undefined)?.content, [
    { type: "thinking", thinking: "hmm more" },
    { type: "text", text: "Hello world" },
  ]);
  assert.deepEqual(
    progress.live?.tools?.filter((call) => call.status !== "done").map((call) => call.callId),
    ["parent"],
  );
  assert.equal(progress.live?.nestedTools?.[0]?.output, "ld!");
  assert.notEqual(progress.live?.generation?.message, before.live?.generation?.message);
  assert.equal(JSON.stringify(projected).includes("private"), false);
  assert.deepEqual(
    (before.live?.generation?.message as AssistantMessage | undefined)?.content,
    message.content,
  );
});

test("root and document replacements restore live state, including an idle run failure", () => {
  const live = {
    runFailure: { taskId: 1, inputs: [], reason: "interrupted", detail: "Host stopped" },
  };
  for (const op of [
    ["r", {}],
    ["s", ["docs"], {}],
    ["s", ["docs", "pi.live"], live],
  ] as Op[])
    assert.deepEqual(projectRunEvent(state({ "pi.live": live }, [op])), {
      type: "live_update",
      ops: [["r", live]],
    });
  assert.equal(projectRunEvent(state({}, [["s", ["docs", "pi.agent"], {}]])), undefined);
});

test("native transcript entries project through Carmel's message serializer", () => {
  const message = { role: "user", content: "question", timestamp: 1 };
  assert.deepEqual(
    projectRunEvent({
      type: "message_end",
      entry: { id: 1, kind: "pi.user", model: [message] } as never,
    }),
    { type: "message_end", message },
  );
});

test("assistant failures still use Pi's overflow detection and provider error", () => {
  assert.equal(
    classifyAssistantFailure(
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider failed" }),
    )?.detail,
    "Provider failed",
  );
});

test("a real streamed turn reassembles from native deltas with immutable snapshots", async () => {
  const { sessionId } = createSession();
  const faux = fauxProvider({
    provider: `faux-stream-${crypto.randomUUID()}`,
    tokensPerSecond: 2000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("weighing the options"),
      fauxText("Hello, world. ".repeat(40)),
    ]),
  ]);
  const pi = await openTestHarness(sessionId, { models, model: faux.getModel() });
  const projected: AgentRunEvent[] = [];
  let rawBytes = 0;
  let progress: RunProgress = {};
  let lastPartial: AssistantMessage | undefined;
  pi.observe((event) => {
    rawBytes += Buffer.byteLength(JSON.stringify(event));
    const wire = projectRunEvent(event);
    if (wire) {
      projected.push(wire);
      progress = applyRunProgress(progress, wire);
      if (progress.live?.generation?.message) lastPartial = progress.live?.generation?.message;
      if (event.type === "state")
        assert.deepEqual(progress.live, event.value.docs["pi.live"] ?? {});
    }
  });
  try {
    await pi.prompt("hello");
    const answer = projected.findLast(
      (event) => event.type === "message_end" && event.message.role === "assistant",
    );
    assert.ok(answer?.type === "message_end");
    assert.ok(lastPartial?.role === "assistant");
    const partialText = lastPartial.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    const finalText = (answer.message as AssistantMessage).content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    assert.ok(partialText.length > 0 && finalText.startsWith(partialText));
    const saved = (await pi.branch()).findLast((entry) => entry.type === "message");
    assert.ok(saved?.type === "message");
    assert.deepEqual(answer.message, saved.message);
    assert.equal(progress.live?.generation?.message, undefined);
    assert.ok(
      projected.some(
        (event) => event.type === "live_update" && event.ops.some((op) => op[0] === "a"),
      ),
    );
    const wireBytes = projected.reduce(
      (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
      0,
    );
    assert.ok(wireBytes < rawBytes);
  } finally {
    await pi.close();
  }
});

/**
 * The regression guard for delegating overflow detection to Pi.
 *
 * Carmel used to carry its own pattern list; it now asks `isContextOverflow`.
 * That is the right call -- one list, and Pi's also knows which
 * overflow-shaped texts are really throttling -- but it moves a decision Carmel
 * depends on into a dependency. These are the provider strings Carmel was
 * written against, so if an upgrade stops recognising one, it fails here rather
 * than silently downgrading a recoverable overflow to "unknown" in production.
 */
for (const message of [
  "400 prompt is too long: 213451 tokens > 200000 maximum",
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 131204 tokens.",
]) {
  test(`Pi still recognises a real overflow: ${message.slice(0, 40)}…`, () => {
    assert.equal(isOverflowMessage(message), true);
    assert.equal(classifyTurnFailure({ message, overflowHint: true }).category, "context_overflow");
  });
}

test("throttling that mentions token limits is not an overflow", () => {
  // The reason this is Pi's job: the texts that look like an overflow but are
  // rate limiting are exactly what a hand-rolled pattern list gets wrong.
  assert.equal(
    isOverflowMessage("429 Request too large for gpt-4: rate limit reached for tokens"),
    false,
  );
});
