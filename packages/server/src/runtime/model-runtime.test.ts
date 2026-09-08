import assert from "node:assert/strict";
import test from "node:test";
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
