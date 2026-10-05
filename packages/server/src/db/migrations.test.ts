import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.ts";
import { seedDatabase } from "./seed.ts";
import { migrate, seed, sqlite } from "./index.ts";

migrate();

test("issue queue upgrade preserves briefs, conversations, reports, and notes without autoqueueing old work", () => {
  const previous = new Database(":memory:");
  previous.pragma("foreign_keys = ON");
  try {
    runMigrations(previous); seedDatabase(previous);
    const session = previous.prepare("SELECT id, user_id, agent_id FROM sessions LIMIT 1").get() as { id: string; user_id: string; agent_id: string };
    previous.prepare("INSERT INTO issues(id,user_id,agent_id,session_id,title,description,status,verdict,verdict_summary,created_at,updated_at) VALUES ('old',?,?,?,'Existing brief','Original criteria','in_review','done','Existing report',1,2)")
      .run(session.user_id, session.agent_id, session.id);
    previous.exec(`
      INSERT INTO issue_attempts(id,issue_id,session_id,instructions,brief,outcome,summary,evidence,created_at,finished_at)
        SELECT 'old-attempt','old',id,'Original instructions','Original brief','succeeded','Existing report','Checks passed',1,2 FROM sessions LIMIT 1;
      INSERT INTO issue_notes(id,issue_id,kind,body,created_at) VALUES ('old-note','old','note','Original context',1);
      DROP INDEX issues_queue;
      ALTER TABLE issues DROP COLUMN queue_position;
      ALTER TABLE issues DROP COLUMN queued_command;
      ALTER TABLE issue_attempts DROP COLUMN snapshot;
      ALTER TABLE issue_notes DROP COLUMN delivery;
      ALTER TABLE issue_notes DROP COLUMN entry_id;
      DELETE FROM schema_migrations WHERE id = '032_issue_queue';
    `);
    const tables = ["issues", "issue_attempts", "issue_notes", "sessions"];
    const before = tables.map((table) => previous.prepare(`SELECT * FROM ${table}`).all());
    runMigrations(previous);
    const after = tables.map((table) => previous.prepare(`SELECT * FROM ${table}`).all().map((row) => {
      const { queue_position: _position, queued_command: _command, snapshot: _snapshot, delivery: _delivery, entry_id: _entry, ...old } = row as Record<string, unknown>;
      return old;
    }));
    assert.deepEqual(after, before);
    assert.deepEqual(previous.prepare("SELECT status, queue_position, queued_command FROM issues").get(), { status: "in_review", queue_position: null, queued_command: null });
    runMigrations(previous);
    assert.deepEqual(previous.pragma("foreign_key_check"), []);
  } finally { previous.close(); }
});

const rowCount = (table: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

test("Pi Azure rename preserves credentials and rewires colliding model references", () => {
  const previous = new Database(":memory:");
  previous.pragma("foreign_keys = ON");
  try {
    runMigrations(previous); seedDatabase(previous);
    const user = previous.prepare("SELECT id FROM users LIMIT 1").get() as { id: string };
    previous.prepare("UPDATE provider_configs SET provider='azure-openai-responses', api_key='configured-key'").run();
    previous.prepare("INSERT INTO model_refs(id,owner_user_id,label,provider,model_id,input,created_at,updated_at) VALUES ('old-azure',?,'Old','azure-openai-responses','deployment','[\"text\"]',1,1),('new-azure',?,'New','azure','deployment','[\"text\"]',2,2)").run(user.id, user.id);
    previous.exec(`
      UPDATE sessions SET model_ref_id='old-azure';
      UPDATE agents SET default_model_ref_id='new-azure';
      UPDATE users SET fast_task_model_ref_id='new-azure';
      INSERT INTO agent_tasks(id,agent_id,user_id,name,prompt,model_ref_id,schedule_kind,schedule_value,created_at,updated_at)
        SELECT 'azure-task',id,owner_user_id,'Task','Prompt','new-azure','once','2026-10-05T00:00:00Z',1,1 FROM agents LIMIT 1;
      INSERT INTO provider_keys(user_id,provider,api_key,created_at,updated_at) SELECT id,'azure-openai-responses','legacy-key',1,1 FROM users;
      DELETE FROM schema_migrations WHERE id='033_pi_azure_provider';
    `);
    runMigrations(previous);
    const model = previous.prepare("SELECT id FROM model_refs WHERE provider='azure' AND model_id='deployment'").get() as { id: string };
    for (const [table, column] of [["sessions", "model_ref_id"], ["agents", "default_model_ref_id"], ["users", "fast_task_model_ref_id"], ["agent_tasks", "model_ref_id"]])
      assert.equal((previous.prepare(`SELECT ${column} AS ref FROM ${table} LIMIT 1`).get() as { ref: string }).ref, model.id);
    assert.deepEqual(previous.prepare("SELECT provider,api_key FROM provider_configs LIMIT 1").get(), { provider: "azure", api_key: "configured-key" });
    assert.deepEqual(previous.prepare("SELECT provider,api_key FROM provider_keys LIMIT 1").get(), { provider: "azure", api_key: "legacy-key" });
    runMigrations(previous);
    assert.deepEqual(previous.pragma("foreign_key_check"), []);
  } finally { previous.close(); }
});

test("all versioned migrations apply and remove legacy session tables", () => {
  const applied = sqlite.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>;
  assert.equal(applied.at(-1)?.id, "033_pi_azure_provider");
  const agentColumns = sqlite.pragma("table_info(agents)") as Array<{ name: string }>;
  assert.ok(!agentColumns.some(({ name }) => name === "enabled_extensions"));

  const legacyTables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_messages', 'pi_session_entries', 'activity')")
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

test("MCP upgrade preserves existing agents and gives them an empty server configuration", () => {
  const previous = new Database(":memory:");
  previous.pragma("foreign_keys = ON");
  try {
    runMigrations(previous);
    seedDatabase(previous);
    previous.exec("ALTER TABLE agents DROP COLUMN mcp_servers; DELETE FROM schema_migrations WHERE id = '029_agent_mcp_servers'");
    const before = previous.prepare("SELECT * FROM agents").all() as Array<Record<string, unknown>>;
    runMigrations(previous);
    runMigrations(previous);
    assert.deepEqual(previous.prepare("SELECT * FROM agents").all(), before.map((agent) => ({ ...agent, mcp_servers: "[]" })));
    assert.deepEqual(previous.pragma("foreign_key_check"), []);
  } finally { previous.close(); }
});

test("codemode upgrade preserves agent settings and promotes legacy server opt-ins", () => {
  for (const legacy of [[], [{ id: "enabled", codemode: true }, { id: "other", codemode: false }], [{ id: "disabled", enabled: false, codemode: true }], [{ id: "off", codemode: false }]]) {
    const previous = new Database(":memory:");
    try {
      runMigrations(previous);
      seedDatabase(previous);
      previous.exec("ALTER TABLE agents DROP COLUMN codemode_enabled; DELETE FROM schema_migrations WHERE id = '030_agent_codemode'");
      previous.prepare("UPDATE agents SET mcp_servers = ?").run(JSON.stringify(legacy));
      const before = previous.prepare("SELECT * FROM agents").all() as Array<Record<string, unknown>>;
      runMigrations(previous);
      runMigrations(previous);
      const expected = legacy.map(({ codemode: _codemode, ...server }) => server);
      assert.deepEqual(previous.prepare("SELECT * FROM agents").all(), before.map((agent) => ({
        ...agent, codemode_enabled: legacy.some((server) => server.codemode === true) ? 1 : 0,
        mcp_servers: JSON.stringify(expected),
      })));
      assert.deepEqual(previous.pragma("foreign_key_check"), []);
    } finally { previous.close(); }
  }
});

test("extension removal preserves existing agents and sessions and is idempotent", () => {
  const previous = new Database(":memory:");
  previous.pragma("foreign_keys = ON");
  try {
    runMigrations(previous);
    seedDatabase(previous);
    const agentsBefore = previous.prepare("SELECT * FROM agents").all();
    const sessionsBefore = previous.prepare("SELECT * FROM sessions").all();
    previous.exec(`
      ALTER TABLE agents ADD COLUMN enabled_extensions TEXT NOT NULL DEFAULT '[]';
      UPDATE agents SET enabled_extensions = '["ext:weather"]';
      DELETE FROM schema_migrations WHERE id = '028_drop_agent_enabled_extensions';
    `);
    runMigrations(previous);
    runMigrations(previous);
    assert.deepEqual(previous.prepare("SELECT * FROM agents").all(), agentsBefore);
    assert.deepEqual(previous.prepare("SELECT * FROM sessions").all(), sessionsBefore);
    assert.deepEqual(previous.pragma("foreign_key_check"), []);
  } finally {
    previous.close();
  }
});

test("inbox removal preserves conversations, issues, and scheduled task history", () => {
  const previous = new Database(":memory:");
  previous.pragma("foreign_keys = ON");
  try {
    runMigrations(previous);
    seedDatabase(previous);
    const session = previous.prepare("SELECT id, user_id AS userId, agent_id AS agentId FROM sessions LIMIT 1").get() as { id: string; userId: string; agentId: string };
    previous.prepare("INSERT INTO issues(id, user_id, agent_id, session_id, title, description, status, created_at, updated_at) VALUES ('issue', ?, ?, ?, 'Review', 'Brief', 'in_review', 1, 2)")
      .run(session.userId, session.agentId, session.id);
    previous.prepare("INSERT INTO issue_attempts(id, issue_id, session_id, instructions, brief, outcome, summary, evidence, created_at, finished_at) VALUES ('attempt', 'issue', ?, '', 'Brief', 'succeeded', 'Done', 'Tests passed', 1, 2)").run(session.id);
    previous.exec("INSERT INTO issue_notes(id, issue_id, kind, body, created_at) VALUES ('note', 'issue', 'result', 'Ready for review', 2)");
    previous.prepare("INSERT INTO agent_tasks(id, agent_id, user_id, name, prompt, schedule_kind, schedule_value, created_at, updated_at) VALUES ('task', ?, ?, 'Check', 'Check files', 'interval', '3600', 1, 2)")
      .run(session.agentId, session.userId);
    previous.prepare("INSERT INTO agent_task_runs(id, task_id, scheduled_for, started_at, finished_at, outcome, detail, session_id) VALUES ('task-run', 'task', 1, 1, 2, 'succeeded', 'Checked', ?)").run(session.id);
    // Reconstruct the retired table, including its foreign keys and indexes.
    previous.exec(`
      CREATE TABLE activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES agent_tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL, summary TEXT NOT NULL, kind TEXT NOT NULL,
        created_at INTEGER NOT NULL, read_at INTEGER
      );
      CREATE INDEX activity_user_recent ON activity(user_id, id DESC);
      CREATE INDEX activity_user_unread ON activity(user_id, read_at, id DESC);
      DELETE FROM schema_migrations WHERE id = '031_drop_activity_inbox';
    `);
    const insert = previous.prepare("INSERT INTO activity(event_key, user_id, agent_id, session_id, issue_id, task_id, title, summary, kind, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, 'Update', 'Result', 'completed', 2, ?)");
    insert.run("session", session.userId, session.agentId, session.id, null, null, null);
    insert.run("issue", session.userId, session.agentId, session.id, "issue", null, 3);
    insert.run("task", session.userId, session.agentId, session.id, null, "task", null);
    const tables = ["users", "agents", "sessions", "issues", "issue_attempts", "issue_notes", "agent_tasks", "agent_task_runs"];
    const before = tables.map((table) => previous.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    runMigrations(previous);
    runMigrations(previous);
    assert.deepEqual(tables.map((table) => previous.prepare(`SELECT * FROM ${table} ORDER BY id`).all()), before);
    assert.deepEqual(previous.prepare("SELECT name FROM sqlite_master WHERE name IN ('activity', 'activity_user_recent', 'activity_user_unread')").all(), []);
    assert.deepEqual(previous.pragma("foreign_key_check"), []);
  } finally { previous.close(); }
});

test("issue workflow upgrade preserves legacy sessions and attempt evidence", () => {
  const previous = new Database(":memory:");
  previous.pragma("foreign_keys = ON");
  try {
    runMigrations(previous); seedDatabase(previous);
    previous.exec("DROP TABLE issue_attempts; DROP TABLE issue_notes; DELETE FROM schema_migrations WHERE id = '027_issue_workflow'");
    const session = previous.prepare("SELECT id, user_id AS userId, agent_id AS agentId FROM sessions LIMIT 1").get() as { id: string; userId: string; agentId: string };
    const insert = previous.prepare(`INSERT INTO issues(id, user_id, agent_id, session_id, title, description, status, last_run_outcome, verdict, verdict_summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Legacy issue', 'Original brief', ?, ?, ?, 'Original report', 1, 2)`);
    for (const [name, status, outcome, verdict] of [
      ["review", "open", "succeeded", "done"], ["done", "resolved", "succeeded", "done"],
      ["question", "open", "succeeded", "needs_input"], ["failure", "open", "failed", "done"], ["abandoned", "cancelled", null, null],
    ]) insert.run(name, session.userId, session.agentId, session.id, status, outcome, verdict);
    runMigrations(previous); runMigrations(previous);
    assert.deepEqual(previous.prepare("SELECT id, status FROM issues ORDER BY id").all(), [
      { id: "abandoned", status: "cancelled" }, { id: "done", status: "done" }, { id: "failure", status: "blocked" }, { id: "question", status: "needs_input" }, { id: "review", status: "in_review" },
    ]);
    const attempts = previous.prepare("SELECT session_id, brief FROM issue_attempts").all();
    assert.equal(attempts.length, 5);
    assert.ok(attempts.every((a) => (a as { session_id: string; brief: string }).session_id === session.id));
    assert.deepEqual(previous.pragma("foreign_key_check"), []);
  } finally { previous.close(); }
});
