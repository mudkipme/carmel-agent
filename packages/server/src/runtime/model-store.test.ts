import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { migrate, sqlite } from "../db/index.ts";
import { SqliteModelsStore } from "./model-store.ts";

migrate();

const cachedModel: Model<Api> = {
  id: "cached-model",
  name: "Cached model",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

test("SQLite model catalogs survive store recreation", async () => {
  const store = new SqliteModelsStore(sqlite);
  await store.write("test-provider", {
    models: [cachedModel],
    checkedAt: 123,
    lastModified: 456,
    etag: '"catalog-v1"',
  });

  const restored = await new SqliteModelsStore(sqlite).read("test-provider");
  assert.deepEqual(restored, {
    models: [cachedModel],
    checkedAt: 123,
    lastModified: 456,
    etag: '"catalog-v1"',
  });
});

test("invalid cached catalogs are removed instead of breaking model discovery", async () => {
  sqlite.prepare(`
    INSERT INTO model_catalogs (provider_id, models) VALUES (?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET models = excluded.models
  `).run("broken-provider", "not-json");

  const store = new SqliteModelsStore(sqlite);
  assert.equal(await store.read("broken-provider"), undefined);
  assert.equal(
    sqlite.prepare("SELECT provider_id FROM model_catalogs WHERE provider_id = ?").get("broken-provider"),
    undefined,
  );
});
