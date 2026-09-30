import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { migrate } from "../db/index.ts";
import { bindResolvedModel, createCarmelModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders, withProviderAttribution } from "./provider-attribution.ts";

migrate();

/**
 * These headers are how OpenRouter decides which app a request belongs to.
 * Carmel drives `pi-agent-core` directly, so it never passes through the CLI
 * code that adds them, and every run showed up in the dashboard as "unknown".
 * The values are the CLI's own -- they must not drift from it.
 */

function openRouterModel(baseUrl: string): Model<Api> {
  return {
    id: "test-model",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl,
    name: "Test model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  } as Model<Api>;
}

test("an OpenRouter model carries Pi's attribution headers", () => {
  assert.deepEqual(mergeProviderAttributionHeaders(openRouterModel("https://openrouter.ai/api/v1"), undefined), {
    "HTTP-Referer": "https://pi.dev",
    "X-OpenRouter-Title": "pi",
    "X-OpenRouter-Categories": "cli-agent",
  });
});

test("a custom endpoint on the OpenRouter provider still attributes", () => {
  const headers = mergeProviderAttributionHeaders(openRouterModel("http://127.0.0.1:9/v1"), undefined);
  assert.equal(headers?.["X-OpenRouter-Title"], "pi");
});

test("auth and request headers win over attribution", () => {
  const headers = mergeProviderAttributionHeaders(openRouterModel("https://openrouter.ai/api/v1"), undefined, {
    "HTTP-Referer": "https://example.test",
    authorization: "Bearer token",
  });
  assert.equal(headers?.["HTTP-Referer"], "https://example.test");
  assert.equal(headers?.authorization, "Bearer token");
  assert.equal(headers?.["X-OpenRouter-Title"], "pi");
});

test("a provider Pi does not attribute is left alone", () => {
  const model = { ...openRouterModel("https://api.openai.com/v1"), provider: "openai" } as Model<Api>;
  assert.equal(mergeProviderAttributionHeaders(model, undefined), undefined);
});

test("PI_TELEMETRY=0 opts out the way it does in the CLI", () => {
  const previous = process.env.PI_TELEMETRY;
  process.env.PI_TELEMETRY = "0";
  try {
    assert.equal(mergeProviderAttributionHeaders(openRouterModel("https://openrouter.ai/api/v1"), undefined), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_TELEMETRY;
    else process.env.PI_TELEMETRY = previous;
  }
});

/**
 * The unit tests above only prove the merge. This one proves the headers
 * survive the whole `pi-ai` request path and land on the socket, which is the
 * part that was actually broken.
 */
test("attribution, runtime auth, and caller headers reach the wire through every chat SDK method", async (t) => {
  let received: IncomingHttpHeaders | undefined;
  const server = createServer((request, response) => {
    received = request.headers;
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "test-model" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const model = openRouterModel(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  const runtime = await createCarmelModelRuntime();
  await runtime.setRuntimeApiKey("openrouter", "test-key");
  const attributed = withProviderAttribution(bindResolvedModel(runtime, model));

  for (const method of ["stream", "streamSimple", "complete", "completeSimple"] as const) {
    const response = attributed[method](model, {
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    }, {
      headers: { "X-Caller": "caller" },
      transformHeaders: (headers) => ({ ...headers, "HTTP-Referer": "https://caller.test" }),
    });
    const result = await ("result" in response ? response.result() : response);
    assert.equal(result.stopReason, "stop", `${method}: ${result.errorMessage}`);
    assert.equal(received?.["http-referer"], "https://caller.test", method);
    assert.equal(received?.["x-openrouter-title"], "pi", method);
    assert.equal(received?.["x-openrouter-categories"], "cli-agent", method);
    assert.equal(received?.authorization, "Bearer test-key", method);
    assert.equal(received?.["x-caller"], "caller", method);
    // Pi stamps its own User-Agent; the merge must preserve it.
    assert.match(received?.["user-agent"] ?? "", /^pi \(/);
  }
});
