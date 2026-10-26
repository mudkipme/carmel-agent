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

test("legacy agent secrets migrate without changing their encrypted payload or scope", () => {
  const sqlite = database();
  try {
    sqlite.exec(`DROP TABLE __drizzle_migrations;
      DROP TABLE agent_secrets;
      CREATE TABLE agent_secrets (agent_id TEXT NOT NULL REFERENCES agents(id), name TEXT NOT NULL,
        value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(agent_id,name));
      INSERT INTO agent_secrets VALUES ('agent_self','GITHUB_TOKEN','enc:v1:preserve-exactly',1,2);`);
    initializeSchema(sqlite);
    const row = sqlite.prepare("SELECT * FROM agent_secrets").get() as Record<string, unknown>;
    assert.equal(typeof row.id, "string");
    assert.equal(row.session_id, null);
    assert.equal(row.value, "enc:v1:preserve-exactly");
    assert.equal(row.name, "GITHUB_TOKEN");
    initializeSchema(sqlite);
    assert.deepEqual(sqlite.prepare("SELECT * FROM agent_secrets").get(), row);
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

test("pre-Home metadata adopts Drizzle migrations while retaining pending IM inputs and saved data", () => {
  const sqlite = database();
  try {
    sqlite.exec(`
      DROP TABLE __drizzle_migrations;
      DROP TABLE helper_hosts;
      DROP TABLE agent_homes;
      DROP TABLE home_events;
      DROP TRIGGER session_search_delete;
      DROP TABLE session_search;
      DROP TABLE session_search_state;
      ALTER TABLE agent_tasks DROP COLUMN notify_platform;
      ALTER TABLE issues DROP COLUMN notify_platform;
      ALTER TABLE im_inbox DROP COLUMN home_event_id;
      ALTER TABLE im_inbox DROP COLUMN legacy;
      ALTER TABLE im_outbox DROP COLUMN home_event_id;
      UPDATE sessions SET title='Retained IM conversation', revision=19;
      INSERT INTO im_integrations(id,agent_id,user_id,platform,bot_id,bot_name,status,updated_at)
        VALUES ('integration','agent_self','user_self','telegram','bot','Demo bot','connected',1);
      INSERT INTO im_bindings(integration_id,sender_id,chat_id,session_id)
        VALUES ('integration','sender','chat','session_initial');
      INSERT INTO im_credentials(integration_id,value) VALUES ('integration','enc:v1:unchanged');
      INSERT INTO im_inbox(id,integration_id,event_id,prompt,status,created_at)
        VALUES ('pending','integration','event','{"text":"Retained input"}','queued',1),
          ('running','integration','event-running','{"text":"Started input"}','running',2),
          ('completed','integration','event-completed','{"text":"Completed input"}','done',3);
    `);
    initializeSchema(sqlite);
    assert.deepEqual(
      sqlite.prepare("SELECT id, session_id, legacy FROM im_inbox ORDER BY created_at").all(),
      [
        { id: "pending", session_id: "session_initial", legacy: 1 },
        { id: "running", session_id: "session_initial", legacy: 1 },
        { id: "completed", session_id: null, legacy: 0 },
      ],
    );
    assert.equal(
      (sqlite.prepare("SELECT prompt FROM im_inbox WHERE id='pending'").get() as { prompt: string })
        .prompt,
      '{"text":"Retained input"}',
    );
    assert.deepEqual(
      sqlite.prepare("SELECT title,revision FROM sessions WHERE id='session_initial'").get(),
      { title: "Retained IM conversation", revision: 19 },
    );
    assert.equal(
      (sqlite.prepare("SELECT value FROM im_credentials").get() as { value: string }).value,
      "enc:v1:unchanged",
    );
    assert.equal(
      (
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get() as {
          count: number;
        }
      ).count,
      2,
    );
    assert.deepEqual(sqlite.prepare("SELECT * FROM agent_homes").all(), []);
    assert.deepEqual(sqlite.prepare("SELECT * FROM helper_hosts").all(), []);
    sqlite.exec(
      "INSERT INTO session_search(session_id,entry_id,text) VALUES ('session_initial','entry','Retained context')",
    );
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM session_search WHERE session_search MATCH 'context'",
          )
          .get() as { count: number }
      ).count,
      1,
    );
    initializeSchema(sqlite);
    assert.equal(
      (
        sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get() as {
          count: number;
        }
      ).count,
      2,
    );
    sqlite.exec(
      "UPDATE im_bindings SET session_id=NULL; DELETE FROM sessions WHERE id='session_initial'",
    );
    assert.equal(
      (sqlite.prepare("SELECT count(*) AS count FROM session_search").get() as { count: number })
        .count,
      0,
    );
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  } finally {
    sqlite.close();
  }
});
