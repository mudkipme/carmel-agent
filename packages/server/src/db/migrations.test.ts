import assert from "node:assert/strict";
import test from "node:test";
import { migrate, seed, sqlite } from "./index.ts";

migrate();

const rowCount = (table: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

test("all versioned migrations apply and remove legacy session tables", () => {
  const applied = sqlite.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>;
  assert.equal(applied.at(-1)?.id, "018_agent_tasks");

  const legacyTables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_messages', 'pi_session_entries')")
    .all();
  assert.deepEqual(legacyTables, []);
  assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
});

test("seed only inserts the initial graph and is idempotent", () => {
  seed();
  const firstCounts = Object.fromEntries(
    ["users", "provider_configs", "model_refs", "agents", "sessions"].map((table) => [table, rowCount(table)]),
  );

  seed();
  const secondCounts = Object.fromEntries(
    ["users", "provider_configs", "model_refs", "agents", "sessions"].map((table) => [table, rowCount(table)]),
  );

  assert.deepEqual(secondCounts, firstCounts);
  assert.deepEqual(firstCounts, {
    users: 1,
    provider_configs: 1,
    model_refs: 1,
    agents: 1,
    sessions: 1,
  });
});

test("model identity constraints are migration-owned", () => {
  const indexes = sqlite.prepare("PRAGMA index_list(model_refs)").all() as Array<{ name: string }>;
  assert.ok(indexes.some(({ name }) => name === "model_refs_provider_config_model_unique"));
  assert.ok(indexes.some(({ name }) => name === "model_refs_provider_model_unique"));
});
