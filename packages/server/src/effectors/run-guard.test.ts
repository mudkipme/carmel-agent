import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RUN_GUARD_LIMITS, RunGuard } from "./run-guard.ts";

const LIMITS = { maxToolCalls: 3, stallTimeoutMs: 1_000 };

test("tool calls up to the ceiling are allowed", () => {
  const { guard } = fixture();
  for (let call = 0; call < LIMITS.maxToolCalls; call++)
    assert.equal(guard.recordToolCall(), undefined);
  assert.equal(guard.stop, undefined);
  assert.equal(guard.toolCalls, 3);
});

test("the call past the ceiling stops the run and says how many it allowed", () => {
  const { guard } = fixture();
  for (let call = 0; call < LIMITS.maxToolCalls; call++) guard.recordToolCall();
  const stop = guard.recordToolCall();
  assert.equal(stop?.reason, "tool_ceiling");
  assert.match(stop?.message ?? "", /stopped after 3 tool calls/);
  assert.equal(guard.stop, stop);
});

test("a run with activity inside the window is not stalled", () => {
  const { guard, advance } = fixture();
  advance(900);
  guard.recordActivity();
  advance(900);
  assert.equal(guard.poll(), undefined);
});

test("silence past the window stops the run", () => {
  const { guard, advance } = fixture();
  advance(1_000);
  const stop = guard.poll();
  assert.equal(stop?.reason, "stalled");
  assert.match(stop?.message ?? "", /without progress/);
});

test("a tool call counts as activity, so a slow tool loop is not called stalled", () => {
  // The two limits catch different things and must not be made to overlap: a
  // run doing real but slow work should hit the ceiling, never the stall timer.
  const { guard, advance } = fixture();
  advance(900);
  guard.recordToolCall();
  advance(900);
  assert.equal(guard.poll(), undefined);
});

test("the first stop wins and is final", () => {
  // A run being torn down keeps emitting events; a second verdict would
  // overwrite the reason the user is about to be shown.
  const { guard, advance } = fixture();
  for (let call = 0; call <= LIMITS.maxToolCalls; call++) guard.recordToolCall();
  assert.equal(guard.stop?.reason, "tool_ceiling");
  advance(10_000);
  assert.equal(guard.poll()?.reason, "tool_ceiling");
  assert.equal(guard.stop?.reason, "tool_ceiling");
});

test("the shipped defaults do not shape ordinary work", () => {
  // A real task can make a hundred tool calls; nothing legitimate is silent for
  // a quarter of an hour.
  assert.ok(DEFAULT_RUN_GUARD_LIMITS.maxToolCalls >= 100);
  assert.ok(DEFAULT_RUN_GUARD_LIMITS.stallTimeoutMs >= 10 * 60_000);
});

function fixture() {
  let clock = 1_000_000;
  const guard = new RunGuard(LIMITS, () => clock);
  return {
    guard,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
