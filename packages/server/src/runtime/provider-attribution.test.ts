import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAttributionHeaders, withClientIdentity } from "@earendil-works/pi-ai/utils/identity";
import { initialize } from "../db/index.ts";
import { bindResolvedModel, createCarmelModelRuntime } from "./model-runtime.ts";
import { piClientIdentity } from "./client-identity.ts";

initialize();

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

test("the app selects Pi's native provider attribution", () => {
  assert.deepEqual(
    getAttributionHeaders(openRouterModel("https://openrouter.ai/api/v1"), piClientIdentity()),
    {
      "HTTP-Referer": "https://pi.dev",
      "X-OpenRouter-Title": "pi",
      "X-OpenRouter-Categories": "cli-agent",
    },
  );
});

test("PI_TELEMETRY=0 opts out the way it does in the CLI", () => {
  const previous = process.env.PI_TELEMETRY;
  process.env.PI_TELEMETRY = "0";
  try {
    assert.equal(piClientIdentity().attribution, null);
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
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const model = openRouterModel(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  const runtime = await createCarmelModelRuntime();
  await runtime.setRuntimeApiKey("openrouter", "test-key");
  const attributed = withClientIdentity(bindResolvedModel(runtime, model), piClientIdentity());

  for (const method of ["stream", "streamSimple", "complete", "completeSimple"] as const) {
    const response = attributed[method](
      model,
      {
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
      },
      {
        headers: { "X-Caller": "caller" },
        transformHeaders: (headers) => ({ ...headers, "HTTP-Referer": "https://caller.test" }),
      },
    );
    const result = await ("result" in response ? response.result() : response);
    assert.equal(result.stopReason, "stop", `${method}: ${result.errorMessage}`);
    assert.equal(received?.["http-referer"], "https://caller.test", method);
    assert.equal(received?.["x-openrouter-title"], "pi", method);
    assert.equal(received?.["x-openrouter-categories"], "cli-agent", method);
    assert.equal(received?.authorization, "Bearer test-key", method);
    assert.equal(received?.["x-caller"], "caller", method);
    // Pi stamps its own User-Agent; the merge must preserve it.
    assert.match(received?.["user-agent"] ?? "", /^pi\//);
  }
});
