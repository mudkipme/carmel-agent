import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { migrate } from "../db/index.ts";
import { createSession, userMessage } from "../test-support.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { createPiAgentDriver } from "../effectors/pi-0-85/agent-driver.ts";
import { attachTestHarness } from "../effectors/testing/pi-harness.ts";
import { replaceSessionMessages, readSessionMessages } from "../services/session-store.ts";
import { createActiveAgentRun, finishAgentRun } from "./run-stream.ts";
import { classifyTurnFailure } from "../effectors/failure-classifier.ts";
import { recoverFromContextOverflow, TurnFailureWatch, HarnessAbortGate } from "./agent-runtime.ts";

migrate();

const OVERFLOW = "400 prompt is too long: 213451 tokens > 200000 maximum";

/**
 * Pi 0.85 recovers a context overflow itself.
 *
 * `publishResponse` classifies an overflowed assistant response, prepares a
 * compaction, and retries the generation once -- all inside `lane.prompt`, before
 * Carmel's recovery is even asked. So the three provider calls this scene scripts
 * are now all Pi's, and Carmel's layer correctly stands down: by the time it
 * looks, the last turn ended clean and there is nothing to plan.
 *
 * Two things changed for the user as a result. The answer still arrives, but the
 * failed attempt is now a persisted entry rather than something Carmel rewound
 * away, and no `run_recovered` notice is emitted because Carmel did not recover
 * anything.
 */
test("a context overflow is recovered by Pi itself, and Carmel stands down", async () => {
  const scene = await setupScene((callCount) => {
    // 0: the turn overflows. 1: the summarization Pi's own recovery makes.
    // 2: Pi's retried turn, which now fits.
    if (callCount === 0) return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
    if (callCount === 1) return fauxAssistantMessage("Summary of the conversation so far.");
    return fauxAssistantMessage("Here is the answer.");
  });

  await scene.promptAndRecover("what is the answer?");

  const roles = (await readSessionMessages(scene.sessionId)).map(describe);
  assert.equal(roles.filter((entry) => entry === "user:what is the answer?").length, 1);
  assert.ok(roles.includes("assistant:Here is the answer."), roles.join(" | "));
  // The failed attempt is Pi's record of what it recovered from, and it stays.
  assert.ok(roles.some((entry) => entry.includes(OVERFLOW)), roles.join(" | "));
  assert.deepEqual(scene.emitted(), []);
  await scene.close();
});

test("a forced compaction runs even though the local estimate says there is room", async () => {
  // The whole point of the force flag: this session is a few hundred tokens
  // against a 200k window, so the estimate declines. The provider already said
  // otherwise, and it is the one that counts.
  const scene = await setupScene((callCount) => {
    if (callCount === 0) return fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW });
    if (callCount === 1) return fauxAssistantMessage("Summary of the conversation so far.");
    return fauxAssistantMessage("Recovered.");
  });

  await scene.promptAndRecover("go");
  // Three calls means the summarization happened between the two turns.
  assert.equal(scene.callCount(), 3);
  await scene.close();
});

test("a failure compaction cannot fix is left for the user", async () => {
  const scene = await setupScene(() =>
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid x-api-key" }),
  );

  await scene.promptAndRecover("go");
  // One call: no summarization, no resend. Retrying an auth failure would just
  // reach the same answer.
  assert.equal(scene.callCount(), 1);
  assert.deepEqual(scene.emitted(), []);
  await scene.close();
});

/**
 * The point of #3: Carmel is the second line, and knows it.
 *
 * Pi compacts and retries the overflow itself; when the retry overflows too, its
 * own recovery is spent (`overflowRecoveryUsed`) and it stops. Compaction is the
 * entire remedy on this path, so Carmel forcing a second one would buy another
 * summarization call and the same rejection. It reports instead.
 */
test("Carmel reports rather than re-compacting once Pi's own recovery is spent", async () => {
  const scene = await setupScene(() => fauxAssistantMessage("Recovered."));
  const baselineId = await scene.seedTurnWithToolResult();

  await scene.recoverFrom(OVERFLOW, baselineId, { piAlreadyCompacted: true });

  // The user is told, and no provider call is made: compaction is the entire
  // remedy on this path and Pi has already spent it.
  assert.deepEqual(scene.emitted(), ["context_pressure"]);
  assert.equal(scene.callCount(), 0);
  await scene.close();
});

test("the run learns from Pi's own compaction_end that its recovery is spent", async () => {
  // The wiring the test above stands in for: without this the flag never sets,
  // and Carmel goes on paying for a second compaction Pi already tried.
  const watch = new TurnFailureWatch();
  assert.equal(watch.piAlreadyCompactedForOverflow, false);
  watch.observe({
    type: "compaction_end",
    lane: "main",
    runId: "run_1",
    reason: "overflow",
    status: "completed",
    entryId: "e1",
    endedAt: 1,
  } as never);
  assert.equal(watch.piAlreadyCompactedForOverflow, true);
});

test("a threshold compaction is not mistaken for spent overflow recovery", () => {
  // Pi compacts at every checkpoint by default. Only the overflow-reasoned one
  // means the remedy has been tried against this failure.
  const watch = new TurnFailureWatch();
  watch.observe({
    type: "compaction_end",
    lane: "main",
    runId: "run_1",
    reason: "threshold",
    status: "completed",
    entryId: "e1",
    endedAt: 1,
  } as never);
  assert.equal(watch.piAlreadyCompactedForOverflow, false);
});

test("Carmel's recovery is skipped once an abort has been requested", async () => {
  const scene = await setupScene(() =>
    fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW }),
  );

  scene.abort.request();
  await scene.promptAndRecover("go");
  // Two calls, both Pi's: the overflowing turn and the summarization its own
  // recovery attempts. Carmel's abort gate does not reach inside `lane.prompt`,
  // so what it can still guarantee is that it adds no recovery of its own.
  assert.equal(scene.callCount(), 2);
  assert.deepEqual(scene.emitted(), []);
  await scene.close();
});

test("an overflow after tool results keeps them and asks the agent to continue", async () => {
  // Driven from a seeded branch rather than a real tool call: what is under test
  // is the choice between discarding the turn and building on it, and that turns
  // entirely on whether tool results landed after the baseline.
  const scene = await setupScene((callCount) => {
    if (callCount === 0) return fauxAssistantMessage("Summary of the conversation so far.");
    return fauxAssistantMessage("Carrying on from the tool output.");
  });

  const baselineId = await scene.seedTurnWithToolResult();
  await scene.recoverFrom(OVERFLOW, baselineId);

  const transcript = (await readSessionMessages(scene.sessionId)).map(describe);
  // The expensive part survives, and the agent was told to build on it.
  assert.ok(transcript.some((entry) => entry.startsWith("toolResult:")), transcript.join(" | "));
  assert.ok(transcript.some((entry) => entry.includes("Do not repeat work that is already complete")), transcript.join(" | "));
  assert.ok(transcript.some((entry) => entry === "assistant:Carrying on from the tool output."), transcript.join(" | "));
  assert.deepEqual(scene.emitted(), ["run_recovered"]);
  await scene.close();
});

async function setupScene(respond: (callCount: number) => AgentMessage) {
  const { sessionId, userId } = createSession();
  // Prior history, so compaction has something to summarize.
  await replaceSessionMessages(sessionId, [
    userMessage("earlier question"),
    fauxAssistantMessage("earlier answer"),
  ]);

  const faux = fauxProvider({ provider: `faux-recovery-${crypto.randomUUID()}`, tokensPerSecond: 5_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  // One step per provider call the scene can make: the failing turn, the
  // summarization compaction issues, and the retried turn.
  const step = (_context: unknown, _options: unknown, state: { callCount: number }) => respond(state.callCount - 1);
  faux.setResponses([step, step, step, step] as never);

  const piSession = await openPiSession(sessionId);
  const model = faux.getModel();
  const pi = await attachTestHarness(piSession, { models, model, systemPrompt: "Test assistant" });
  const { harness, lane, log, context } = pi;
  const dispatch = { harness, lane, context };
  const driver = createPiAgentDriver({ harness, lane, context, log, model });
  const watch = new TurnFailureWatch();
  const abort = new HarnessAbortGate();
  abort.attach(lane);

  const emitted: string[] = [];
  const run = createActiveAgentRun({ runId: `run_${sessionId}`, userId, sessionId, abort: () => abort.request() });
  const unsubscribe = pi.observe((event) => watch.observe(event));

  return {
    sessionId,
    abort,
    callCount: () => faux.state.callCount,
    emitted: () => emitted,
    async promptAndRecover(text: string) {
      const attemptBaselineId = (await log.readBranch()).at(-1)?.id ?? null;
      await lane.prompt(text, undefined, context);
      const before = run.nextSequence;
      await recoverFromContextOverflow(
        { run, abort, session: { id: sessionId } } as never,
        { driver, dispatch, log, failure: watch.last, attemptBaselineId, promptInput: { text } },
      );
      for (const envelope of run.events) {
        if (envelope.sequence >= before) emitted.push(envelope.event.type);
      }
    },
    /** Append an assistant tool call and its result, and return the leaf before them. */
    async seedTurnWithToolResult() {
      const baselineId = (await log.readBranch()).at(-1)?.id ?? null;
      await log.appendMessage(userMessage("read the file"));
      await log.appendMessage({
        ...fauxAssistantMessage(""),
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      } as unknown as AgentMessage);
      await log.appendMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as AgentMessage);
      return baselineId;
    },
    async recoverFrom(
      providerError: string,
      attemptBaselineId: string | null,
      options: { piAlreadyCompacted?: boolean } = {},
    ) {
      const before = run.nextSequence;
      await recoverFromContextOverflow(
        { run, abort, session: { id: sessionId } } as never,
        {
          driver,
          dispatch,
          log,
          failure: classifyTurnFailure({ message: providerError, overflowHint: true }),
          piAlreadyCompacted: options.piAlreadyCompacted,
          attemptBaselineId,
          promptInput: { text: "read the file" },
        },
      );
      for (const envelope of run.events) {
        if (envelope.sequence >= before) emitted.push(envelope.event.type);
      }
    },
    async close() {
      unsubscribe();
      finishAgentRun(run);
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
