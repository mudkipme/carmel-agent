import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { db, migrate, sqlite } from "../db/index.ts";
import { providerConfigs } from "../db/schema.ts";
import { SqliteModelsStore } from "../runtime/model-store.ts";
import { createProviderConfig, createUser } from "../test-support.ts";
import { readProviderModels } from "./model-catalog.ts";

migrate();

const remoteModel: Model<Api> = {
  id: "openai-future-test-model",
  name: "Future test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
  contextWindow: 512_000,
  maxTokens: 64_000,
};

test("remote Pi catalogs are persisted across runtimes and retained after refresh failure", async (t) => {
  const userId = createUser();
  const providerConfigId = createProviderConfig(userId);
  db.update(providerConfigs)
    .set({ apiKey: "test-api-key" })
    .where(eq(providerConfigs.id, providerConfigId))
    .run();
  const providerConfig = db.select().from(providerConfigs).where(eq(providerConfigs.id, providerConfigId)).get();
  assert.ok(providerConfig);

  let failRefresh = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (failRefresh) throw new Error("catalog unavailable");
    const url = input instanceof Request ? input.url : input.toString();
    assert.equal(url, "https://catalog.test/api/models/providers/openai");
    return new Response(JSON.stringify({ [remoteModel.id]: remoteModel }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "last-modified": new Date("2035-01-01T00:00:00.000Z").toUTCString(),
        etag: '"future-catalog"',
      },
    });
  });
  const catalogBaseUrl = "https://catalog.test";
  const store = new SqliteModelsStore(sqlite);

  const refreshed = await readProviderModels(providerConfig, {
    catalogBaseUrl,
    force: true,
    modelsStore: store,
  });
  assert.ok(refreshed.some((model) => model.id === remoteModel.id));

  const restored = await readProviderModels(providerConfig, {
    allowNetwork: false,
    catalogBaseUrl,
    modelsStore: new SqliteModelsStore(sqlite),
  });
  assert.ok(restored.some((model) => model.id === remoteModel.id));

  failRefresh = true;
  const afterFailure = await readProviderModels(providerConfig, {
    catalogBaseUrl,
    force: true,
    modelsStore: new SqliteModelsStore(sqlite),
    timeoutMs: 1_000,
  });
  assert.ok(afterFailure.some((model) => model.id === remoteModel.id));
});
