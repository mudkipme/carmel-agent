import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { initializeSchema } from "./setup.ts";
import { seedDatabase } from "./seed.ts";

function database(legacy = false) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  if (legacy) {
    for (const migration of ["0000_metadata_baseline.sql", "0001_session_search.sql"])
      sqlite.exec(readFileSync(new URL(`../../drizzle/${migration}`, import.meta.url), "utf8"));
    seedAgentOwnedEnvironment(sqlite);
  } else {
    initializeSchema(sqlite);
    seedDatabase(sqlite);
  }
  return sqlite;
}

/** The seed as it was written before environments split from agents. */
function seedAgentOwnedEnvironment(sqlite: Database.Database) {
  sqlite.exec(`
    INSERT INTO users(id,name,email,created_at,updated_at) VALUES ('user_self','Local User','user@local',1,1);
    INSERT INTO provider_configs(id,user_id,label,provider,created_at,updated_at)
      VALUES ('provider_default','user_self','Default','anthropic',1,1);
    INSERT INTO model_refs(id,owner_user_id,label,provider,provider_config_id,model_id,input,created_at,updated_at)
      VALUES ('model_default','user_self','Model','anthropic','provider_default','model','["text"]',1,1);
    INSERT INTO agents(id,owner_user_id,name,description,working_dir_mode,working_dir,default_working_dir,
        system_prompt,prompt_templates,permissions,default_model_ref_id,created_at,updated_at)
      VALUES ('agent_self','user_self','Local Agent','','default','agents/agent_self/workspace',
        'agents/agent_self/workspace','','[]',
        '{"read":true,"write":true,"edit":true,"bash":false,"network":false}','model_default',1,1);
    INSERT INTO sessions(id,title,user_id,agent_id,model_ref_id,thinking_level,created_at,updated_at)
      VALUES ('session_initial','Initial session','user_self','agent_self','model_default','off',1,1);
  `);
}

/** A database migrated up to, but not including, `tag`. */
function databaseBefore(tag: string) {
  const folder = mkdtempSync(join(tmpdir(), "carmel-migrations-"));
  cpSync(fileURLToPath(new URL("../../drizzle/", import.meta.url)), folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === tag);
  assert.ok(cutoff > 0, `migration ${tag} exists`);
  journal.entries = journal.entries.slice(0, cutoff);
  writeFileSync(journalPath, JSON.stringify(journal));
  const sqlite = new Database(":memory:");
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  sqlite.pragma("foreign_keys = ON");
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

test("pre-Home metadata adopts Drizzle migrations while retaining saved data", () => {
  const sqlite = database(true);
  try {
    sqlite.exec(`
      DROP TABLE helper_hosts;
      DROP TABLE agent_homes;
      DROP TABLE home_events;
      DROP TRIGGER session_search_delete;
      DROP TABLE session_search;
      DROP TABLE session_search_state;
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
    const migrations = sqlite.prepare("SELECT * FROM __drizzle_migrations").all();
    assert.ok(migrations.length);
    assert.deepEqual(sqlite.prepare("SELECT icon,color FROM agents WHERE id='agent_self'").get(), {
      icon: "bot",
      color: null,
    });
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
    assert.deepEqual(sqlite.prepare("SELECT * FROM __drizzle_migrations").all(), migrations);
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

test("agents become environments without moving files or losing what references them", () => {
  const sqlite = databaseBefore("0013_environments");
  try {
    seedAgentOwnedEnvironment(sqlite);
    sqlite.exec(`
      INSERT INTO agents(id,owner_user_id,name,description,working_dir_mode,working_dir,mounts,
          system_prompt,prompt_templates,permissions,default_model_ref_id,created_at,updated_at)
        VALUES ('agent_manual','user_self','Manual','','manual','/srv/project',
          '[{"source":"/srv/refs","readOnly":true}]','','[]',
          '{"read":true,"write":true,"edit":true,"bash":true,"network":true}','model_default',2,3);
      INSERT INTO agent_secrets(id,agent_id,name,value,created_at,updated_at)
        VALUES ('secret_default','agent_self','TOKEN','enc:v1:kept',1,1);
      INSERT INTO agent_secrets(id,agent_id,session_id,name,value,created_at,updated_at)
        VALUES ('secret_session','agent_self','session_initial','TOKEN','enc:v1:session',1,1);
      INSERT INTO knowledge_configs(agent_id,settings,status)
        VALUES ('agent_self','{"enabled":true,"acceleration":"auto"}','{}');
      INSERT INTO home_memory_settings(user_id,agent_id) VALUES ('user_self','agent_self');
    `);
    initializeSchema(sqlite);

    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT id,owner_user_id,name,storage_dir,working_dir_mode,working_dir,default_working_dir,mounts,network FROM environments ORDER BY id",
        )
        .all(),
      [
        {
          id: "agent_manual",
          owner_user_id: "user_self",
          name: "Manual",
          storage_dir: "agents/agent_manual",
          working_dir_mode: "manual",
          working_dir: "/srv/project",
          default_working_dir: "agents/agent_manual/workspace",
          mounts: '[{"source":"/srv/refs","readOnly":true}]',
          network: 1,
        },
        {
          id: "agent_self",
          owner_user_id: "user_self",
          name: "Local Agent",
          storage_dir: "agents/agent_self",
          working_dir_mode: "default",
          working_dir: "agents/agent_self/workspace",
          default_working_dir: "agents/agent_self/workspace",
          mounts: "[]",
          network: 0,
        },
      ],
    );
    assert.deepEqual(sqlite.prepare("SELECT id,environment_id FROM agents ORDER BY id").all(), [
      { id: "agent_manual", environment_id: "agent_manual" },
      { id: "agent_self", environment_id: "agent_self" },
    ]);
    assert.deepEqual(
      sqlite
        .prepare("SELECT id,environment_id,session_id,value FROM environment_secrets ORDER BY id")
        .all(),
      [
        {
          id: "secret_default",
          environment_id: "agent_self",
          session_id: null,
          value: "enc:v1:kept",
        },
        {
          id: "secret_session",
          environment_id: "agent_self",
          session_id: "session_initial",
          value: "enc:v1:session",
        },
      ],
    );
    // Rebuilding `agents` must not fire the cascades that point at it.
    assert.equal(
      (sqlite.prepare("SELECT count(*) AS count FROM knowledge_configs").get() as { count: number })
        .count,
      1,
    );
    assert.equal(
      (
        sqlite.prepare("SELECT count(*) AS count FROM home_memory_settings").get() as {
          count: number;
        }
      ).count,
      1,
    );
    assert.equal(sqlite.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  } finally {
    sqlite.close();
  }
});
