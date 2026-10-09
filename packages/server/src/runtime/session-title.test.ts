import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { initialize } from "../db/index.ts";
import { createCarmelModelRuntime } from "./model-runtime.ts";
import { generateSessionTitle } from "./session-title.ts";

initialize();

test("titles use the configured SDK provider, including providers without API keys", async () => {
  const runtime = await createCarmelModelRuntime();
  const faux = fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([
    (context, options) => {
      assert.match(getCurrentSystemPrompt(context.messages) ?? "", /concise chat title/);
      assert.ok(options?.signal instanceof AbortSignal);
      assert.equal(options.timeoutMs, 60_000);
      assert.equal(options.maxTokens, 64);
      return fauxAssistantMessage('"Plan a Weekend Trip."');
    },
  ]);

  const title = await generateSessionTitle({
    model: faux.getModel(),
    modelRuntime: runtime,
    messages: [{ role: "user", content: "Plan a weekend trip", timestamp: 0 }],
  });
  assert.equal(title, "Plan a Weekend Trip");
  assert.equal(faux.state.callCount, 1);
});

test("title provider failures are reported and empty conversations make no request", async () => {
  const runtime = await createCarmelModelRuntime();
  const faux = fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  assert.equal(
    await generateSessionTitle({ model: faux.getModel(), modelRuntime: runtime, messages: [] }),
    undefined,
  );
  assert.equal(faux.state.callCount, 0);

  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Title provider unavailable" }),
  ]);
  await assert.rejects(
    generateSessionTitle({
      model: faux.getModel(),
      modelRuntime: runtime,
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    }),
    /Title provider unavailable/,
  );
});
