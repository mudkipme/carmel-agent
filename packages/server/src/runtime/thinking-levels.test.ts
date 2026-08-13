import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { resolveModelRef, type ModelRef } from "@carmel-agent/shared";
import { migrate, sqlite } from "../db/index.ts";
import { modelCatalogStore, resetCatalogCache } from "./model-store.ts";
import { thinkingLevelOverrides } from "./model.ts";

migrate();

// Pi gates "xhigh"/"max" on the model carrying a `thinkingLevelMap` entry for
// them. Any step that rebuilds a Model without that map silently caps the
// thinking selector at "high", which is what these tests guard against.

const reasoningRef: ModelRef = {
  id: "ref-1",
  ownerUserId: "user-1",
  shared: false,
  label: "Reasoning model",
  provider: "openai",
  modelId: "reasoning-model",
  api: "openai-responses",
  reasoning: true,
  input: ["text"],
};

test("a reasoning model without a level map stops at high", () => {
  const levels = getSupportedThinkingLevels(resolveModelRef(reasoningRef));
  assert.deepEqual(levels, ["off", "minimal", "low", "medium", "high"]);
});

test("a stored level map survives resolveModelRef and unlocks xhigh/max", () => {
  const resolved = resolveModelRef({
    ...reasoningRef,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  });
  assert.deepEqual(getSupportedThinkingLevels(resolved), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("a catalog level map reaches the caller when the ref defines none", () => {
  const resolved = resolveModelRef(reasoningRef, {
    catalogModel: {
      ...resolveModelRef(reasoningRef),
      thinkingLevelMap: { max: "max" },
    },
  });
  assert.equal(resolved.thinkingLevelMap?.max, "max");
  assert.ok(getSupportedThinkingLevels(resolved).includes("max"));
});

test("the stored entry overrides the catalog per level, keeping unrelated keys", () => {
  const resolved = resolveModelRef(
    { ...reasoningRef, thinkingLevelMap: { max: "ultra" } },
    {
      catalogModel: {
        ...resolveModelRef(reasoningRef),
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
    },
  );
  assert.equal(resolved.thinkingLevelMap?.max, "ultra");
  assert.equal(resolved.thinkingLevelMap?.xhigh, "xhigh");
});

test("a level explicitly marked unsupported stays unavailable", () => {
  const resolved = resolveModelRef({
    ...reasoningRef,
    thinkingLevelMap: { xhigh: "xhigh", max: null },
  });
  const levels = getSupportedThinkingLevels(resolved);
  assert.ok(levels.includes("xhigh"));
  assert.ok(!levels.includes("max"));
});

test("a model that only accepts high/max hides the lower levels", () => {
  // The shape DeepSeek publishes for deepseek-v4-pro.
  const resolved = resolveModelRef({
    ...reasoningRef,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  });
  assert.deepEqual(getSupportedThinkingLevels(resolved), ["off", "high", "max"]);
});

test("a model that cannot disable thinking drops off", () => {
  const resolved = resolveModelRef({
    ...reasoningRef,
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  });
  const levels = getSupportedThinkingLevels(resolved);
  assert.ok(!levels.includes("off"));
  assert.ok(levels.includes("max"));
});

test("catalog-supplied levels are not persisted back onto the model entry", async () => {
  const provider = "levels-test-provider";
  await modelCatalogStore.write(provider, {
    models: [
      {
        ...resolveModelRef({ ...reasoningRef, provider, modelId: "catalog-model" }),
        id: "catalog-model",
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
      },
    ],
  });
  resetCatalogCache();

  // The client echoes back the effective map the serializer sent it.
  const echoed = {
    provider,
    modelId: "catalog-model",
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  };
  assert.equal(thinkingLevelOverrides(echoed), null);

  // A genuine user change is kept, and only that level.
  const edited = {
    provider,
    modelId: "catalog-model",
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max", xhigh: "xhigh" },
  };
  assert.deepEqual(thinkingLevelOverrides(edited), { xhigh: "xhigh" });

  sqlite.prepare("DELETE FROM model_catalogs WHERE provider_id = ?").run(provider);
  resetCatalogCache();
});

test("a non-reasoning model is unaffected by a level map", () => {
  const resolved = resolveModelRef({
    ...reasoningRef,
    reasoning: false,
    thinkingLevelMap: { max: "max" },
  });
  assert.deepEqual(getSupportedThinkingLevels(resolved), ["off"]);
});
