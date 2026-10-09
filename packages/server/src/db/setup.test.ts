import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeSchema } from "./setup.ts";
import { seedDatabase } from "./seed.ts";

function database() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  initializeSchema(sqlite);
  seedDatabase(sqlite);
  return sqlite;
}

test("initialization and seeding preserve existing data on repeated startup", () => {
  const sqlite = database();
  try {
    sqlite.exec(
      "UPDATE agents SET codemode_enabled=1, mcp_servers='[{\"id\":\"configured\"}]'; UPDATE sessions SET title='Saved conversation', revision=12, archived_at=42;",
    );
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const snapshot = () => tables.map(({ name }) => sqlite.prepare(`SELECT * FROM ${name}`).all());
    const before = snapshot();
    initializeSchema(sqlite);
    seedDatabase(sqlite);
    assert.deepEqual(snapshot(), before);
    assert.equal(
      (sqlite.prepare("SELECT count(*) AS count FROM users").get() as { count: number }).count,
      1,
    );
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  } finally {
    sqlite.close();
  }
});

test("model identity uniqueness is scoped to its configured provider or builtin provider", () => {
  const sqlite = database();
  try {
    const insert =
      sqlite.prepare(`INSERT INTO model_refs(id,owner_user_id,label,provider,provider_config_id,model_id,input,created_at,updated_at)
      VALUES (?,'user_self','Test',?,?,'same-model','["text"]',1,1)`);
    insert.run("builtin", "first", null);
    assert.throws(() => insert.run("duplicate-builtin", "first", null), /UNIQUE/);
    insert.run("another-provider", "second", null);
    insert.run("configured", "first", "provider_default");
    assert.throws(() => insert.run("duplicate-config", "second", "provider_default"), /UNIQUE/);
    assert.throws(() => sqlite.exec("DELETE FROM users WHERE id='user_self'"), /FOREIGN KEY/);
  } finally {
    sqlite.close();
  }
});

test("current issue schema defaults to todo and enforces one running attempt with cascading history", () => {
  const sqlite = database();
  try {
    sqlite.exec(`
      INSERT INTO issues(id,agent_id,user_id,session_id,title,description,created_at,updated_at)
        VALUES ('issue','agent_self','user_self','session_initial','Brief','Task',1,1);
      INSERT INTO issue_notes(id,issue_id,kind,body,delivery,entry_id,created_at)
        VALUES ('note','issue','note','Context','delivered','durable:12',1);
    `);
    assert.deepEqual(
      sqlite
        .prepare("SELECT status,criteria,priority,queue_position,queued_command FROM issues")
        .get(),
      {
        status: "todo",
        criteria: "[]",
        priority: "normal",
        queue_position: null,
        queued_command: null,
      },
    );
    const attempt =
      sqlite.prepare(`INSERT INTO issue_attempts(id,issue_id,session_id,instructions,brief,outcome,snapshot,created_at)
      VALUES (?,'issue','session_initial','Work','Task',?,'{}',1)`);
    attempt.run("first", "running");
    assert.throws(() => attempt.run("second", "running"), /UNIQUE/);
    attempt.run("finished", "succeeded");
    sqlite.exec("DELETE FROM issues WHERE id='issue'");
    assert.equal(
      (sqlite.prepare("SELECT count(*) AS count FROM issue_attempts").get() as { count: number })
        .count,
      0,
    );
    assert.equal(
      (sqlite.prepare("SELECT count(*) AS count FROM issue_notes").get() as { count: number })
        .count,
      0,
    );
  } finally {
    sqlite.close();
  }
});
