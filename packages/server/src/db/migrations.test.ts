import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.ts";
import { seedDatabase } from "./seed.ts";
import { migrate, seed, sqlite } from "./index.ts";

migrate();

const rowCount = (table: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

test("all versioned migrations apply and remove legacy session tables", () => {
  const applied = sqlite.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>;
  assert.equal(applied.at(-1)?.id, "026_activity_inbox");

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

test("inbox upgrade preserves open issue outcomes without reviving resolved work", () => {
  const previous = new Database(":memory:");
  previous.pragma("foreign_keys = ON");
  try {
    runMigrations(previous);
    seedDatabase(previous);
    previous.exec("DROP TABLE activity; DELETE FROM schema_migrations WHERE id = '026_activity_inbox'");
    const session = previous.prepare("SELECT id, user_id AS userId, agent_id AS agentId FROM sessions LIMIT 1").get() as { id: string; userId: string; agentId: string };
    const insert = previous.prepare(`INSERT INTO issues(id, user_id, agent_id, session_id, title, description, status, last_run_outcome, verdict, verdict_summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Review this', 'Brief', ?, 'succeeded', 'needs_input', 'Which region?', 1, 2)`);
    insert.run("open-issue", session.userId, session.agentId, session.id, "open");
    insert.run("closed-issue", session.userId, session.agentId, session.id, "resolved");
    runMigrations(previous);
    runMigrations(previous);
    const rows = previous.prepare("SELECT issue_id, kind, summary, read_at FROM activity").all();
    assert.deepEqual(rows, [{ issue_id: "open-issue", kind: "needs_input", summary: "Which region?", read_at: null }]);
    assert.deepEqual(previous.pragma("foreign_key_check"), []);
  } finally { previous.close(); }
});
