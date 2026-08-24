import test from "node:test";
import assert from "node:assert/strict";
import {
  decideCompaction,
  describeContextPressure,
  PI_083_COMPACTION_SETTINGS,
  type CompactionSettings,
} from "./compaction-policy.ts";
import { createPi083AgentDriver, type Pi083Harness } from "./pi-0-83/agent-driver.ts";
import { FakeSessionLog } from "./testing/fake-session-log.ts";

const SETTINGS: CompactionSettings = { reserveTokens: 100, keepRecentTokens: 200 };

test("a session under the threshold is left alone", () => {
  const decision = decideCompaction({ tokens: 500, contextWindow: 1_000, settings: SETTINGS });
  assert.equal(decision.action, "none");
  assert.equal(decision.headroom, 900);
});

test("a session over the threshold compacts when the retained tail fits", () => {
  assert.equal(decideCompaction({ tokens: 950, contextWindow: 1_000, settings: SETTINGS }).action, "compact");
});

test("a window smaller than the reserve is impossible, even when empty", () => {
  // Pi's own predicate reads `tokens > windowMinusReserve`, which is true at
  // zero tokens when the reserve exceeds the window -- so this configuration
  // used to request compaction on the first turn of a brand-new session.
  assert.deepEqual(decideCompaction({ tokens: 0, contextWindow: 50, settings: SETTINGS }), {
    action: "impossible",
    tokens: 0,
    headroom: -50,
    reason: "window_below_reserve",
  });
});

test("a retained tail larger than the headroom is impossible, not worth a model call", () => {
  // Threshold is 250 - 100 = 150, and compaction cannot get below the 200-token
  // tail it must keep. Attempting it costs a summarization call per turn and
  // changes nothing.
  assert.deepEqual(decideCompaction({ tokens: 300, contextWindow: 250, settings: SETTINGS }), {
    action: "impossible",
    tokens: 300,
    headroom: 150,
    reason: "retained_tail_exceeds_headroom",
  });
});

test("Pi's shipped defaults make every window at or below 36,384 tokens uncompactable", () => {
  // The reachable case: someone adds a locally-served model as an Ollama entry
  // and sets its real window. Asserted on the exact boundary so a change to
  // either default fails here rather than in production.
  const at = decideCompaction({ tokens: 1_000_000, contextWindow: 36_384 });
  const above = decideCompaction({ tokens: 1_000_000, contextWindow: 36_385 });
  assert.equal(at.action, "impossible");
  assert.equal(above.action, "compact");
  assert.equal(
    PI_083_COMPACTION_SETTINGS.reserveTokens + PI_083_COMPACTION_SETTINGS.keepRecentTokens,
    36_384,
  );
});

test("only actionable outcomes produce a notice", () => {
  assert.equal(describeContextPressure({ status: "not_needed", tokens: 1, headroom: 9 }), undefined);
  assert.equal(
    describeContextPressure({ status: "compacted", tokensBefore: 9, tokensAfter: 2, headroom: 8 }),
    undefined,
  );
  assert.equal(
    describeContextPressure({ status: "failed", tokens: 9, headroom: 8, code: "unknown", reason: "boom" })?.level,
    "warning",
  );
  assert.equal(
    describeContextPressure({ status: "ineffective", tokensBefore: 9, tokensAfter: 9, headroom: 8 })?.level,
    "critical",
  );
});

test("an impossible session is reported without calling compact", async () => {
  const harness = fakeHarness();
  const driver = driverFor(harness, { tokens: 300, contextWindow: 250 });
  assert.deepEqual(await driver.relieveContextPressure(), {
    status: "impossible",
    tokens: 300,
    headroom: 150,
    reason: "retained_tail_exceeds_headroom",
  });
  assert.equal(harness.compactCalls, 0, "an impossible compaction must not reach the model");
});

test("a compaction that does not free enough room reports ineffective, not success", async () => {
  // Nothing errored. The session is still over budget, and the next turn would
  // pay for another summarization call to discover the same thing.
  const harness = fakeHarness();
  const driver = driverFor(harness, { tokens: [950, 940], contextWindow: 1_000 });
  assert.deepEqual(await driver.relieveContextPressure(), {
    status: "ineffective",
    tokensBefore: 950,
    tokensAfter: 940,
    headroom: 900,
  });
  assert.equal(harness.compactCalls, 1);
});

test("a compaction that frees enough room reports the measured after-size", async () => {
  const harness = fakeHarness();
  const driver = driverFor(harness, { tokens: [950, 300], contextWindow: 1_000 });
  assert.deepEqual(await driver.relieveContextPressure(), {
    status: "compacted",
    tokensBefore: 950,
    tokensAfter: 300,
    headroom: 900,
  });
});

test("'Nothing to compact' is a state of the session, not a failure", async () => {
  const harness = fakeHarness(() => {
    throw Object.assign(new Error("Nothing to compact"), { code: "compaction" });
  });
  const outcome = await driverFor(harness, { tokens: 950, contextWindow: 1_000 }).relieveContextPressure();
  assert.equal(outcome.status, "nothing_to_compact");
});

test("a real compaction failure keeps its code and message for the notice", async () => {
  const harness = fakeHarness(() => {
    throw Object.assign(new Error("provider exploded"), { code: "summarization_failed" });
  });
  const outcome = await driverFor(harness, { tokens: 950, contextWindow: 1_000 }).relieveContextPressure();
  assert.deepEqual(outcome, {
    status: "failed",
    tokens: 950,
    headroom: 900,
    code: "summarization_failed",
    reason: "provider exploded",
  });
  assert.equal(describeContextPressure(outcome)?.level, "warning");
});

function fakeHarness(onCompact?: () => void) {
  const harness = {
    compactCalls: 0,
    async compact() {
      harness.compactCalls += 1;
      onCompact?.();
    },
    getResources: () => ({ skills: [], promptTemplates: [] }),
    prompt: async () => {},
    skill: async () => {},
    promptFromTemplate: async () => {},
    subscribe: () => () => {},
    abort: async () => {},
  };
  return harness as unknown as Pi083Harness & { compactCalls: number };
}

/** `tokens` as an array scripts successive measurements: before, then after. */
function driverFor(harness: Pi083Harness, input: { tokens: number | number[]; contextWindow: number }) {
  const readings = Array.isArray(input.tokens) ? [...input.tokens] : [input.tokens];
  return createPi083AgentDriver({
    harness,
    log: new FakeSessionLog(),
    model: { contextWindow: input.contextWindow } as never,
    settings: SETTINGS,
    estimateTokens: async () => readings.shift() ?? readings.at(-1) ?? 0,
  });
}
