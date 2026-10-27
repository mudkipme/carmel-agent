import test from "node:test";
import assert from "node:assert/strict";
import { compactionSettingsForWindow } from "./compaction-policy.ts";

test("Durable keeps overflow recovery enabled with a feasible policy on small model windows", () => {
  for (const window of [2, 512, 4_096, 8_192, 32_768, 36_384, 200_000]) {
    for (const kind of ["session", "home"] as const) {
      const policy = compactionSettingsForWindow(window, kind);
      const headroom = window - policy.reserveTokens;
      assert.equal(policy.enabled, true);
      assert.ok(policy.keepRecentTokens < headroom);
      assert.ok(policy.backgroundTokens < headroom);
      assert.ok(policy.backgroundTokens >= 0);
    }
  }
});

test("Home compacts earlier and keeps a shorter tail without reducing answer headroom", () => {
  for (const window of [8_192, 32_768, 200_000, 1_000_000]) {
    const normal = compactionSettingsForWindow(window);
    const home = compactionSettingsForWindow(window, "home");
    const threshold = window - home.reserveTokens - home.backgroundTokens;
    assert.equal(home.reserveTokens, normal.reserveTokens);
    assert.equal(threshold, Math.min(48_000, Math.floor((window - normal.reserveTokens) / 2)));
    assert.ok(home.backgroundTokens > normal.backgroundTokens);
    assert.ok(home.keepRecentTokens < normal.keepRecentTokens);
    assert.deepEqual(compactionSettingsForWindow(window, "session"), normal);
  }
});

test("Home reserves conversation space above fixed instructions and tools within the model window", () => {
  const window = 200_000;
  const base = compactionSettingsForWindow(window, "home", 32_000);
  assert.equal(window - base.reserveTokens - base.backgroundTokens, 80_000);
  assert.equal(base.keepRecentTokens, 12_000);

  for (const fixed of [0, 32_000, 48_000, 64_000]) {
    const small = compactionSettingsForWindow(64_000, "home", fixed);
    const blocking = 64_000 - small.reserveTokens;
    const available = Math.max(0, blocking - fixed);
    assert.equal(small.reserveTokens, compactionSettingsForWindow(64_000).reserveTokens);
    assert.ok(small.keepRecentTokens <= available / 5);
    if (available > 0) {
      const conversation = blocking - small.backgroundTokens - fixed;
      assert.equal(conversation, Math.max(1, Math.floor(available / 2)));
    } else {
      assert.equal(small.backgroundTokens, 0);
    }
  }
});
