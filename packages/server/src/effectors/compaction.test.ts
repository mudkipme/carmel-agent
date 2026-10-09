import test from "node:test";
import assert from "node:assert/strict";
import { compactionSettingsForWindow } from "./compaction-policy.ts";

test("Durable keeps overflow recovery enabled with a feasible policy on small model windows", () => {
  for (const window of [2, 512, 4_096, 8_192, 32_768, 36_384, 200_000]) {
    const policy = compactionSettingsForWindow(window);
    const headroom = window - policy.reserveTokens;
    assert.equal(policy.enabled, true);
    assert.ok(policy.keepRecentTokens < headroom);
    assert.ok(policy.backgroundTokens < headroom);
  }
});
