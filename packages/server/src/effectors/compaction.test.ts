import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import {
  compactionCannotHelp,
  describePreflightPressure,
  PI_COMPACTION_SETTINGS,
  type CompactionSettings,
} from "./compaction-policy.ts";

const SETTINGS: CompactionSettings = { reserveTokens: 100, keepRecentTokens: 200 };

test("the restated settings are Pi's shipped defaults", () => {
  // The arithmetic here predicts what Pi will do, so a changed default must
  // fail here rather than quietly mispredict in production.
  assert.equal(PI_COMPACTION_SETTINGS.reserveTokens, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
  assert.equal(PI_COMPACTION_SETTINGS.keepRecentTokens, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
});

test("a window with room past the retained tail can be compacted", () => {
  assert.equal(compactionCannotHelp(1_000, SETTINGS), undefined);
});

test("a window smaller than the reserve cannot be compacted, even when empty", () => {
  // Pi's own predicate reads `tokens > windowMinusReserve`, which is true at
  // zero tokens when the reserve exceeds the window.
  assert.equal(compactionCannotHelp(50, SETTINGS), "window_below_reserve");
  assert.equal(describePreflightPressure({ tokens: 0, contextWindow: 50, settings: SETTINGS })?.level, "critical");
});

test("a retained tail larger than the headroom cannot be compacted under budget", () => {
  // Headroom is 250 - 100 = 150, and compaction cannot get below the 200-token
  // tail it must keep.
  assert.equal(compactionCannotHelp(250, SETTINGS), "retained_tail_exceeds_headroom");
});

test("Pi's shipped defaults make every window at or below 36,384 tokens uncompactable", () => {
  // The reachable case: a locally-served model added as an Ollama entry with
  // its real window. Asserted on the exact boundary.
  assert.equal(compactionCannotHelp(36_384), "retained_tail_exceeds_headroom");
  assert.equal(compactionCannotHelp(36_385), undefined);
});

test("the pre-flight notice waits until the session is actually over budget", () => {
  // An uncompactable window is only worth interrupting the user for once the
  // session no longer fits; before that, there is nothing to act on.
  assert.equal(describePreflightPressure({ tokens: 100, contextWindow: 250, settings: SETTINGS }), undefined);
  assert.equal(describePreflightPressure({ tokens: 300, contextWindow: 250, settings: SETTINGS })?.level, "critical");
  // A compactable window never gets a pre-flight notice: Pi handles it.
  assert.equal(describePreflightPressure({ tokens: 5_000, contextWindow: 1_000, settings: SETTINGS }), undefined);
});
