import test from "node:test";
import assert from "node:assert/strict";
import { classifyTurnFailure } from "./failure-classifier.ts";
import { planContextRecovery } from "./turn-recovery.ts";

const overflow = classifyTurnFailure({ message: "400 prompt is too long: 213451 tokens > 200000 maximum" });

test("a turn that succeeded is not recovered", () => {
  assert.deepEqual(planContextRecovery({ failure: undefined, turnProducedToolResults: false }), { action: "none" });
});

test("an overflow with no durable work is resent", () => {
  assert.deepEqual(planContextRecovery({ failure: overflow, turnProducedToolResults: false }), { action: "resend" });
});

test("an overflow after tool results continues instead of discarding them", () => {
  assert.deepEqual(planContextRecovery({ failure: overflow, turnProducedToolResults: true }), { action: "continue" });
});

test("failures a retry cannot fix are left alone", () => {
  // Compaction is the remedy for overflow specifically. Retrying an expired
  // credential or an exhausted quota spends the user's tokens to reach the same
  // answer, and a malformed tool history needs a person.
  for (const message of [
    "401 invalid x-api-key",
    "429 You exceeded your current quota. code: insufficient_quota",
    "`tool_use` ids were found without `tool_result` blocks",
    "529 Overloaded",
  ]) {
    const failure = classifyTurnFailure({ message });
    assert.deepEqual(
      planContextRecovery({ failure, turnProducedToolResults: false }),
      { action: "none" },
      message,
    );
  }
});

test("an aborted turn is never recovered", () => {
  const failure = classifyTurnFailure({ message: "Operation aborted", aborted: true });
  assert.deepEqual(planContextRecovery({ failure, turnProducedToolResults: true }), { action: "none" });
});
