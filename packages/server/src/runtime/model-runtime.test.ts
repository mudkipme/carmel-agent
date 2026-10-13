import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryModelsStore,
  InMemoryCredentialStore,
  isModelType,
  type ClassifierModel,
  type ImageModel,
} from "@earendil-works/pi-ai";
import { initialize } from "../db/index.ts";
import { bindResolvedModel, createCarmelModelRuntime } from "./model-runtime.ts";
import { resolveServerModelRef } from "./model.ts";

initialize();

const OPENAI_MODEL_ID = "gpt-4o-mini";

test("OpenRouter personalized catalogs stay isolated by key and endpoint, including offline and after rotation", async (t) => {
  const store = new InMemoryModelsStore();
  const firstCredentials = new InMemoryCredentialStore();
  const secondCredentials = new InMemoryCredentialStore();
  await firstCredentials.modify("openrouter", async () => ({ type: "api_key", key: "first-key" }));
  await secondCredentials.modify("openrouter", async () => ({
    type: "api_key",
    key: "second-key",
  }));
  const models = ["first-model", "second-model"].map(
    (id) =>
      ({
        id,
        name: id,
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 4_096,
      }) satisfies import("@earendil-works/pi-ai").Model<"openai-completions">,
  );
  // A legacy shared row must never be restored into a personalized runtime.
  await store.write("openrouter", { models: [models[1]!] });
  const options = { modelsStore: store, catalogBaseUrl: "https://catalog.test" };
  const first = await createCarmelModelRuntime(firstCredentials, options);
  assert.equal(first.getModel("openrouter", "second-model"), undefined);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/models/user")) {
      const key = new Headers(init?.headers).get("authorization");
      return Response.json({
        data: [
          {
            id: key === "Bearer first-key" ? "first-model" : "second-model",
            context_length: key === "Bearer first-key" ? 16_000 : 24_000,
            top_provider: { max_completion_tokens: 2_000 },
          },
        ],
      });
    }
    return url.pathname.endsWith("/openrouter")
      ? Response.json(models, { headers: { "last-modified": "Mon, 01 Jan 2035 00:00:00 GMT" } })
      : new Response(null, { status: 404 });
  });
  await first.refresh({ allowNetwork: true, force: true });
  const second = await createCarmelModelRuntime(secondCredentials, options);
  await second.refresh({ allowNetwork: true, force: true });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Must remain offline");
  });
  const restoredFirst = await createCarmelModelRuntime(firstCredentials, options);
  const restoredSecond = await createCarmelModelRuntime(secondCredentials, options);
  assert.equal(restoredFirst.getModel("openrouter", "first-model")?.contextWindow, 16_000);
  assert.equal(restoredFirst.getModel("openrouter", "second-model"), undefined);
  assert.equal(restoredSecond.getModel("openrouter", "second-model")?.contextWindow, 24_000);
  assert.equal(restoredSecond.getModel("openrouter", "first-model"), undefined);
  const otherEndpoint = await createCarmelModelRuntime(firstCredentials, {
    ...options,
    personalizedCatalogScope: "https://us.openrouter.ai/api/v1",
  });
  assert.equal(otherEndpoint.getModel("openrouter", "first-model"), undefined);
  await firstCredentials.modify("openrouter", async () => ({
    type: "api_key",
    key: "rotated-key",
  }));
  const rotated = await createCarmelModelRuntime(firstCredentials, options);
  assert.equal(rotated.getModel("openrouter", "first-model"), undefined);
  assert.equal((await store.read("openrouter"))?.models[0]?.id, "second-model");
});

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
    await bound
      .stream(model, { messages: [{ role: "user", content: "ping", timestamp: 0 }] })
      .result();
  });

  assert.equal(destinations.length, 1);
  assert.equal(new URL(destinations[0]!).origin, "http://127.0.0.1:9911");
});

test("two configurations of one provider and model ID keep their own endpoints", async () => {
  const first = await createCarmelModelRuntime();
  const second = await createCarmelModelRuntime();
  const boundFirst = bindResolvedModel(
    first,
    resolveWithEndpoint(first, "http://127.0.0.1:9911/v1"),
  );
  const boundSecond = bindResolvedModel(
    second,
    resolveWithEndpoint(second, "http://127.0.0.1:9922/v1"),
  );

  assert.equal(boundFirst.getModel("openai", OPENAI_MODEL_ID)?.baseUrl, "http://127.0.0.1:9911/v1");
  assert.equal(
    boundSecond.getModel("openai", OPENAI_MODEL_ID)?.baseUrl,
    "http://127.0.0.1:9922/v1",
  );
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
  const bound = bindResolvedModel(
    runtime,
    resolveWithEndpoint(runtime, "http://127.0.0.1:9911/v1"),
  );

  assert.equal(
    bound.getModel("openai", "gpt-4o")?.baseUrl,
    runtime.getModel("openai", "gpt-4o")?.baseUrl,
  );
  assert.deepEqual(bound.getProvider("openai")?.id, runtime.getProvider("openai")?.id);
  assert.equal(
    bound.getModels("openai").find((model) => model.id === OPENAI_MODEL_ID)?.baseUrl,
    "http://127.0.0.1:9911/v1",
  );
});

test("typed and mixed SDK lookups retain the bound chat endpoint without altering other model types", async () => {
  const store = new InMemoryModelsStore();
  const image: ImageModel<"openai-images"> = {
    id: OPENAI_MODEL_ID,
    name: "Image model",
    type: "image",
    provider: "openai",
    api: "openai-images",
    baseUrl: "https://images.test/v1",
    input: ["text"],
    output: ["image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const classifier: ClassifierModel<"typesafe-system-one"> = {
    ...image,
    type: "classifier",
    api: "typesafe-system-one",
    contextWindow: 8192,
  };
  await store.write("openai", { models: [image, classifier], lastModified: Date.UTC(2035, 0, 1) });
  const runtime = await createCarmelModelRuntime(undefined, { modelsStore: store });
  await runtime.setRuntimeApiKey("openai", "test-key");
  const baseUrl = "http://127.0.0.1:9911/v1";
  const bound = bindResolvedModel(runtime, resolveWithEndpoint(runtime, baseUrl));

  assert.equal(bound.getPhysicalModel("openai", OPENAI_MODEL_ID)?.baseUrl, baseUrl);
  assert.equal(bound.getModelOfType("chat", "openai", OPENAI_MODEL_ID)?.baseUrl, baseUrl);
  assert.equal(
    bound.getModelsOfType("chat", "openai").find((model) => model.id === OPENAI_MODEL_ID)?.baseUrl,
    baseUrl,
  );
  assert.equal(
    (await bound.getAvailableOfType("chat", "openai")).find((model) => model.id === OPENAI_MODEL_ID)
      ?.baseUrl,
    baseUrl,
  );
  for (const models of [bound.getAllModels("openai"), await bound.getAllAvailable("openai")]) {
    assert.equal(
      models.find((model) => model.id === OPENAI_MODEL_ID && isModelType(model, "chat"))?.baseUrl,
      baseUrl,
    );
    assert.deepEqual(
      models.find((model) => model.id === OPENAI_MODEL_ID && model.type === "image"),
      image,
    );
    assert.deepEqual(
      models.find((model) => model.id === OPENAI_MODEL_ID && model.type === "classifier"),
      classifier,
    );
  }
  assert.deepEqual(bound.getModelOfType("image", "openai", OPENAI_MODEL_ID), image);
  assert.deepEqual(bound.getModelOfType("classifier", "openai", OPENAI_MODEL_ID), classifier);
  assert.deepEqual(
    bound.getModelsOfType("classifier", "openai"),
    runtime.getModelsOfType("classifier", "openai"),
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
