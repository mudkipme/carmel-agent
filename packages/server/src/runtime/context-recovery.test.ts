import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRunEvent } from "@carmel-agent/shared";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { migrate } from "../db/index.ts";
import { createSession, userMessage } from "../test-support.ts";
import { openPiSession, replacePiSessionMessages } from "../services/pi-session-storage.ts";
import { attachTestHarness } from "../effectors/testing/pi-harness.ts";
import { readSessionMessages } from "../services/session-store.ts";
import { OVERFLOW_RECOVERED } from "../effectors/compaction-policy.ts";
import { ContextReporter } from "./agent-runtime.ts";

migrate();

const OVERFLOW = "400 prompt is too long: 213451 tokens > 200000 maximum";

/**
 * Pi 0.85 does all the compacting: it compacts and retries an overflowed
 * generation once, inside `lane.prompt`. Carmel's part is what the user is
 * told, and these scenes drive a real harness to check that against what Pi
 * actually emits.
 */

test("Pi's own overflow recovery is announced, so the client can clear the error it already showed", async () => {
  const scene = await setupScene((callCount) => {
    // 0: the turn overflows. 1: the summarization Pi's recovery makes.
    // 2: Pi's retried generation, which now fits.
    if (callCount === 0) return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
    if (callCount === 1) return fauxAssistantMessage("Summary of the conversation so far.");
    return fauxAssistantMessage("Here is the answer.");
  });

  await scene.prompt("what is the answer?");

  const roles = (await readSessionMessages(scene.sessionId)).map(describe);
  assert.equal(roles.filter((entry) => entry === "user:what is the answer?").length, 1);
  assert.ok(roles.includes("assistant:Here is the answer."), roles.join(" | "));
  assert.deepEqual(scene.emitted(), [{ type: "run_recovered", message: OVERFLOW_RECOVERED }]);
  assert.equal(scene.reporter.lastTurnFailure, undefined, "the run ended clean");
  await scene.close();
});

test("an overflow that survives Pi's compaction is reported as unrecoverable", async () => {
  const scene = await setupScene((callCount) => {
    if (callCount === 1) return fauxAssistantMessage("Summary of the conversation so far.");
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
  });

  await scene.prompt("go");

  // Pi retries once and stops; Carmel does not spend a second summarization.
  assert.equal(scene.callCount(), 3);
  const types = scene.emitted().map((event) => event.type);
  assert.deepEqual(types, ["run_recovered", "context_pressure"]);
  const notice = scene.emitted()[1] as Extract<AgentRunEvent, { type: "context_pressure" }>;
  assert.equal(notice.level, "critical");
  assert.match(notice.message, /compaction did not recover it/);
  await scene.close();
});

test("a failed overflow compaction warns once and is not reported again as unrecoverable", async () => {
  // Everything errors, so Pi's summarization fails too: the user hears about
  // the failed compaction, and the overflow is not reported a second time.
  const scene = await setupScene(() => fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }));

  await scene.prompt("go");

  assert.deepEqual(scene.emitted().map((event) => event.type), ["context_pressure"]);
  const notice = scene.emitted()[0] as Extract<AgentRunEvent, { type: "context_pressure" }>;
  assert.equal(notice.level, "warning");
  assert.match(notice.message, /Automatic compaction failed/);
  await scene.close();
});

test("a failure compaction cannot fix is left to the error the client already shows", async () => {
  const scene = await setupScene(() =>
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid x-api-key" }),
  );

  await scene.prompt("go");

  assert.equal(scene.callCount(), 1);
  assert.equal(scene.reporter.lastTurnFailure?.category, "auth");
  assert.deepEqual(scene.emitted(), []);
  await scene.close();
});

test("a threshold compaction is not mistaken for overflow recovery", () => {
  const emitted: AgentRunEvent[] = [];
  const reporter = new ContextReporter(undefined, (event) => emitted.push(event));
  reporter.observe({
    type: "compaction_end",
    reason: "threshold",
    status: "completed",
    entryId: "e1",
    runId: "run_1",
    endedAt: 1,
  } as never);
  assert.deepEqual(emitted, []);
});

test("an overflow Pi declined to compact says there was nothing to summarize", () => {
  const emitted: AgentRunEvent[] = [];
  const reporter = new ContextReporter(undefined, (event) => emitted.push(event));
  reporter.observe({
    type: "turn_end",
    message: { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: OVERFLOW },
    toolResults: [],
  } as never);
  reporter.reportUnrecoveredOverflow();

  assert.deepEqual(emitted.map((event) => event.type), ["context_pressure"]);
  assert.match((emitted[0] as { message: string }).message, /no older history to summarize/);
});

async function setupScene(respond: (callCount: number) => AgentMessage) {
  const { sessionId } = createSession();
  // Prior history, so compaction has something to summarize.
  await replacePiSessionMessages(sessionId, [userMessage("earlier question"), fauxAssistantMessage("earlier answer")]);

  const faux = fauxProvider({ provider: `faux-recovery-${crypto.randomUUID()}`, tokensPerSecond: 5_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const step = (_context: unknown, _options: unknown, state: { callCount: number }) => respond(state.callCount - 1);
  faux.setResponses([step, step, step, step] as never);

  const model = faux.getModel();
  const pi = await attachTestHarness(await openPiSession(sessionId), { models, model, systemPrompt: "Test assistant" });
  const emitted: AgentRunEvent[] = [];
  const reporter = new ContextReporter(model.contextWindow, (event) => emitted.push(event));
  const unsubscribe = pi.observe((event) => reporter.observe(event));

  return {
    sessionId,
    reporter,
    callCount: () => faux.state.callCount,
    emitted: () => emitted,
    async prompt(text: string) {
      await pi.lane.prompt(text, undefined, pi.context);
      reporter.reportUnrecoveredOverflow();
    },
    async close() {
      unsubscribe();
      await pi.close();
    },
  };
}

function describe(message: AgentMessage) {
  const record = message as { role: string; content: unknown; errorMessage?: string };
  const text = typeof record.content === "string"
    ? record.content
    : Array.isArray(record.content)
      ? record.content.map((part) => (part as { text?: string }).text ?? "").join("")
      : "";
  return `${record.role}:${text}${record.errorMessage ? `|${record.errorMessage}` : ""}`;
}
