import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryModelsStore, isModelType, type ClassifierModel, type ImageModel } from "@earendil-works/pi-ai";
import { migrate } from "../db/index.ts";
import { bindResolvedModel, createCarmelModelRuntime } from "./model-runtime.ts";
import { resolveServerModelRef } from "./model.ts";

migrate();

const OPENAI_MODEL_ID = "gpt-4o-mini";

/**
 * Resolve a model ref the way a run does, through the same runtime the run will
 * execute on.
 */
function resolveWithEndpoint(
  modelRuntime: Awaited<ReturnType<typeof createCarmelModelRuntime>>,
  baseUrl: string,
  overrides: { provider?: string; modelId?: string } = {},
) {
  const modelRef = {
    provider: overrides.provider ?? "openai",
    modelId: overrides.modelId ?? OPENAI_MODEL_ID,
    label: "Custom",
    api: "openai-completions",
    baseUrl,
  } as never;
  return resolveServerModelRef(modelRef, { baseUrl } as never, modelRuntime);
}

test("the lookup Pi generates with resolves to the configured endpoint", async () => {
  const runtime = await createCarmelModelRuntime();
  const baseUrl = "http://127.0.0.1:9911/v1";

  // Unbound, the catalog answer is authoritative and the endpoint is lost.
  assert.equal(runtime.getModel("openai", OPENAI_MODEL_ID)?.baseUrl, "https://api.openai.com/v1");

  const bound = bindResolvedModel(runtime, resolveWithEndpoint(runtime, baseUrl));
  assert.equal(bound.getModel("openai", OPENAI_MODEL_ID)?.baseUrl, baseUrl);
});

test("a bound model reaches the configured host rather than the provider default", async () => {
  const runtime = await createCarmelModelRuntime();
  await runtime.setRuntimeApiKey("openai", "test-key");
  const baseUrl = "http://127.0.0.1:9911/v1";
  const bound = bindResolvedModel(runtime, resolveWithEndpoint(runtime, baseUrl));

  const destinations = await recordRequests(async () => {
    // Exactly what Pi does at generation time: identity in, model out, stream.
    const model = bound.getModel("openai", OPENAI_MODEL_ID);
    assert.ok(model);
    await bound.stream(model, { messages: [{ role: "user", content: "ping", timestamp: 0 }] }).result();
  });

  assert.equal(destinations.length, 1);
  assert.equal(new URL(destinations[0]!).origin, "http://127.0.0.1:9911");
});

test("two configurations of one provider and model ID keep their own endpoints", async () => {
  const first = await createCarmelModelRuntime();
  const second = await createCarmelModelRuntime();
  const boundFirst = bindResolvedModel(first, resolveWithEndpoint(first, "http://127.0.0.1:9911/v1"));
  const boundSecond = bindResolvedModel(second, resolveWithEndpoint(second, "http://127.0.0.1:9922/v1"));

  assert.equal(boundFirst.getModel("openai", OPENAI_MODEL_ID)?.baseUrl, "http://127.0.0.1:9911/v1");
  assert.equal(boundSecond.getModel("openai", OPENAI_MODEL_ID)?.baseUrl, "http://127.0.0.1:9922/v1");
});

test("a model the catalog does not know is still resolvable", async () => {
  const runtime = await createCarmelModelRuntime();
  const baseUrl = "http://127.0.0.1:9911/v1";
  const model = resolveWithEndpoint(runtime, baseUrl, { modelId: "gateway-only-model" });
  const bound = bindResolvedModel(runtime, model);

  assert.equal(runtime.getModel("openai", "gateway-only-model"), undefined);
  assert.equal(bound.getModel("openai", "gateway-only-model")?.baseUrl, baseUrl);
});

test("binding leaves other models and runtime methods untouched", async () => {
  const runtime = await createCarmelModelRuntime();
  const bound = bindResolvedModel(runtime, resolveWithEndpoint(runtime, "http://127.0.0.1:9911/v1"));

  assert.equal(bound.getModel("openai", "gpt-4o")?.baseUrl, runtime.getModel("openai", "gpt-4o")?.baseUrl);
  assert.deepEqual(bound.getProvider("openai")?.id, runtime.getProvider("openai")?.id);
  assert.equal(
    bound.getModels("openai").find((model) => model.id === OPENAI_MODEL_ID)?.baseUrl,
    "http://127.0.0.1:9911/v1",
  );
});

test("typed and mixed SDK lookups retain the bound chat endpoint without altering other model types", async () => {
  const store = new InMemoryModelsStore();
  const image: ImageModel<"openai-images"> = {
    id: OPENAI_MODEL_ID, name: "Image model", type: "image", provider: "openai",
    api: "openai-images", baseUrl: "https://images.test/v1", input: ["text"],
    output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const classifier: ClassifierModel<"typesafe-system-one"> = {
    ...image, type: "classifier", api: "typesafe-system-one", contextWindow: 8192,
  };
  await store.write("openai", { models: [image, classifier], lastModified: Date.UTC(2035, 0, 1) });
  const runtime = await createCarmelModelRuntime(undefined, { modelsStore: store });
  await runtime.setRuntimeApiKey("openai", "test-key");
  const baseUrl = "http://127.0.0.1:9911/v1";
  const bound = bindResolvedModel(runtime, resolveWithEndpoint(runtime, baseUrl));

  assert.equal(bound.getPhysicalModel("openai", OPENAI_MODEL_ID)?.baseUrl, baseUrl);
  assert.equal(bound.getModelOfType("chat", "openai", OPENAI_MODEL_ID)?.baseUrl, baseUrl);
  assert.equal(bound.getModelsOfType("chat", "openai").find((model) => model.id === OPENAI_MODEL_ID)?.baseUrl, baseUrl);
  assert.equal((await bound.getAvailableOfType("chat", "openai")).find((model) => model.id === OPENAI_MODEL_ID)?.baseUrl, baseUrl);
  for (const models of [bound.getAllModels("openai"), await bound.getAllAvailable("openai")]) {
    assert.equal(models.find((model) => model.id === OPENAI_MODEL_ID && isModelType(model, "chat"))?.baseUrl, baseUrl);
    assert.deepEqual(models.find((model) => model.id === OPENAI_MODEL_ID && model.type === "image"), image);
    assert.deepEqual(models.find((model) => model.id === OPENAI_MODEL_ID && model.type === "classifier"), classifier);
  }
  assert.deepEqual(bound.getModelOfType("image", "openai", OPENAI_MODEL_ID), image);
  assert.deepEqual(bound.getModelsOfType("classifier", "openai"), [classifier]);
});

/** Collect every URL the block sends a request to, without letting one out. */
async function recordRequests(run: () => Promise<unknown>) {
  const originalFetch = globalThis.fetch;
  const destinations: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    destinations.push(input instanceof Request ? input.url : String(input));
    throw new Error("Fixture: request intercepted.");
  };
  try {
    await run().catch(() => undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return destinations;
}
