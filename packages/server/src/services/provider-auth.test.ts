import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEFAULT_OLLAMA_BASE_URL, OLLAMA_PROVIDER, resolveModelRef } from "@carmel-agent/shared";
import { createCarmelModelRuntime } from "../runtime/model-runtime.ts";
import { ensureOptionalProviderAuth, listOllamaModels } from "./provider-auth.ts";

test("Ollama is registered as an authenticated OpenAI-compatible provider", async () => {
  const runtime = await createCarmelModelRuntime();

  await ensureOptionalProviderAuth(runtime, OLLAMA_PROVIDER);

  const provider = runtime.getProvider(OLLAMA_PROVIDER);
  assert.ok(provider);
  assert.equal(provider.baseUrl, DEFAULT_OLLAMA_BASE_URL);
  assert.equal((await runtime.checkAuth(OLLAMA_PROVIDER))?.type, "api_key");
});

test("Ollama registration keeps a configured endpoint", async () => {
  const runtime = await createCarmelModelRuntime();
  const baseUrl = "http://ollama.internal:11434/v1";

  await ensureOptionalProviderAuth(runtime, OLLAMA_PROVIDER, baseUrl);

  assert.equal(runtime.getProvider(OLLAMA_PROVIDER)?.baseUrl, baseUrl);
});

test("Ollama discovery exposes thinking levels and reasoning effort support", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method });

    return new Response(
      JSON.stringify({
        models: [{ name: "qwen3:8b" }, { name: "gpt-oss:20b" }, { name: "llama3.2" }],
      }),
    );
  };

  try {
    const models = await listOllamaModels("http://ollama.internal:11434/v1");

    const qwen = models.find((model) => model.id === "qwen3:8b");
    assert.equal(qwen?.reasoning, true);
    assert.deepEqual(
      getSupportedThinkingLevels(
        resolveModelRef({
          id: "qwen-ref",
          ownerUserId: "user-1",
          shared: false,
          label: "qwen3:8b",
          provider: OLLAMA_PROVIDER,
          modelId: "qwen3:8b",
          reasoning: qwen?.reasoning,
          thinkingLevelMap: qwen?.thinkingLevelMap,
        }),
      ),
      ["off", "low", "medium", "high", "max"],
    );

    const gptOss = models.find((model) => model.id === "gpt-oss:20b");
    assert.deepEqual(gptOss?.thinkingLevelMap, {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });

    const regular = models.find((model) => model.id === "llama3.2");
    assert.equal(regular?.reasoning, true);
    assert.deepEqual(regular?.thinkingLevelMap, {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: "max",
    });
    assert.ok(
      requests.some((request) => request.url.endsWith("/api/tags") && request.method === "GET"),
    );
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
