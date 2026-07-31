import Database from "better-sqlite3";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { agents, modelRefs, providerConfigs, sessions, users } from "./schema.ts";
import { defaultAgent, defaultModelRef, defaultProviderConfig, defaultSession, defaultUser, id, now } from "./seed.ts";
import { dataDir, defaultAgentWorkingDir, ensureParentDir, normalizeDataRelativePath } from "../paths.ts";

const databaseUrl = process.env.DATABASE_URL ?? `${dataDir}/carmel-agent.sqlite`;
const databasePath = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;

ensureParentDir(databasePath);

export const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

type Migration = {
  id: string;
  description: string;
  run: () => void;
};

const migrations: Migration[] = [
  {
    id: "001_initial_schema",
    description: "Create base Carmel Agent tables",
    run: createBaseSchema,
  },
  {
    id: "002_current_schema_compat",
    description: "Backfill legacy columns and current indexes",
    run: applyCurrentSchemaCompatibility,
  },
  {
    id: "003_session_pins",
    description: "Add session pin metadata",
    run: addSessionPins,
  },
  {
    id: "004_drop_agent_skills",
    description: "Remove the global skill selection column",
    run: dropAgentSkills,
  },
  {
    id: "005_agent_mounts",
    description: "Add per-agent additional runner mounts",
    run: addAgentMounts,
  },
  {
    id: "006_session_messages_table",
    description: "Move session messages into their own table",
    run: moveSessionMessagesToTable,
  },
  {
    id: "007_access_indexes",
    description: "Index the columns used by access-control and reassignment queries",
    run: createAccessIndexes,
  },
  {
    id: "008_drop_custom_headers",
    description: "Remove unused custom header columns from providers and models",
    run: dropCustomHeaders,
  },
  {
    id: "009_user_roles",
    description: "Add user roles; existing accounts become admins",
    run: addUserRoles,
  },
  {
    id: "010_pi_session_entries",
    description: "Create native Pi session trees and migrate flat transcripts",
    run: migrateFlatTranscriptsToPiSessionEntries,
  },
  {
    id: "011_restrict_host_paths",
    description: "Move non-admin agents off privileged host paths and mounts",
    run: restrictNonAdminAgentHostPaths,
  },
];

export function migrate() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    sqlite.prepare("SELECT id FROM schema_migrations").all().map((row) => (row as { id: string }).id),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    sqlite.exec("BEGIN");
    try {
      migration.run();
      sqlite
        .prepare("INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)")
        .run(migration.id, migration.description, now());
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function createBaseSchema() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT,
      password_hash TEXT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      fast_task_model_ref_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_refs (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      shared INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_config_id TEXT,
      model_id TEXT NOT NULL,
      api TEXT,
      base_url TEXT,
      context_window INTEGER,
      max_tokens INTEGER,
      reasoning INTEGER NOT NULL DEFAULT 0,
      input TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_configs (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'api_key',
      api_key TEXT,
      oauth_credential TEXT,
      base_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      shared INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      working_dir_mode TEXT NOT NULL DEFAULT 'manual',
      working_dir TEXT NOT NULL,
      default_working_dir TEXT,
      mounts TEXT NOT NULL DEFAULT '[]',
      system_prompt TEXT NOT NULL,
      prompt_templates TEXT NOT NULL,
      permissions TEXT NOT NULL,
      default_model_ref_id TEXT NOT NULL REFERENCES model_refs(id),
      default_thinking_level TEXT NOT NULL DEFAULT 'off',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      model_ref_id TEXT NOT NULL REFERENCES model_refs(id),
      thinking_level TEXT NOT NULL,
      forked_from TEXT,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS session_messages_session_seq
      ON session_messages(session_id, seq);

    CREATE TABLE IF NOT EXISTS pi_session_entries (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      parent_id TEXT,
      entry_type TEXT NOT NULL,
      entry TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, entry_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS pi_session_entries_session_seq
      ON pi_session_entries(session_id, seq);

    CREATE TABLE IF NOT EXISTS provider_keys (
      user_id TEXT NOT NULL REFERENCES users(id),
      provider TEXT NOT NULL,
      api_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, provider)
    );
  `);
}

function applyCurrentSchemaCompatibility() {
  addColumnIfMissing("users", "username", "TEXT");
  addColumnIfMissing("users", "password_hash", "TEXT");
  addColumnIfMissing("users", "fast_task_model_ref_id", "TEXT");
  addColumnIfMissing("model_refs", "owner_user_id", "TEXT");
  addColumnIfMissing("model_refs", "shared", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("model_refs", "provider_config_id", "TEXT");
  addColumnIfMissing("provider_configs", "auth_type", "TEXT NOT NULL DEFAULT 'api_key'");
  addColumnIfMissing("provider_configs", "oauth_credential", "TEXT");
  addColumnIfMissing("agents", "working_dir_mode", "TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing("agents", "default_working_dir", "TEXT");
  addColumnIfMissing("agents", "default_thinking_level", "TEXT NOT NULL DEFAULT 'off'");
  addColumnIfMissing("sessions", "pinned_at", "INTEGER");
  backfillModelOwners();
  normalizeDefaultAgentWorkingDirs();
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
      ON users(username)
      WHERE username IS NOT NULL;
  `);
}

function addSessionPins() {
  addColumnIfMissing("sessions", "pinned_at", "INTEGER");
}

function dropAgentSkills() {
  dropColumnIfExists("agents", "skills");
}

function addAgentMounts() {
  addColumnIfMissing("agents", "mounts", "TEXT NOT NULL DEFAULT '[]'");
}

function moveSessionMessagesToTable() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS session_messages_session_seq
      ON session_messages(session_id, seq);
  `);

  const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "messages")) return;

  const timestamp = now();
  const rows = sqlite
    .prepare("SELECT id, messages FROM sessions")
    .all() as Array<{ id: string; messages: string | null }>;
  const insert = sqlite.prepare(
    "INSERT INTO session_messages (id, session_id, seq, message, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    parseMessagesBlob(row.messages).forEach((message, seq) => {
      insert.run(id("session_message"), row.id, seq, JSON.stringify(message), timestamp);
    });
  }
  sqlite.exec("ALTER TABLE sessions DROP COLUMN messages");
}

function createAccessIndexes() {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS agents_owner_user_id ON agents(owner_user_id);
    CREATE INDEX IF NOT EXISTS agents_default_model_ref_id ON agents(default_model_ref_id);
    CREATE INDEX IF NOT EXISTS model_refs_owner_user_id ON model_refs(owner_user_id);
    CREATE INDEX IF NOT EXISTS model_refs_provider_config_id ON model_refs(provider_config_id);
    CREATE INDEX IF NOT EXISTS provider_configs_user_id ON provider_configs(user_id);
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_agent_id ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS sessions_model_ref_id ON sessions(model_ref_id);
    CREATE INDEX IF NOT EXISTS users_fast_task_model_ref_id ON users(fast_task_model_ref_id);
  `);
}

export function migrateFlatTranscriptsToPiSessionEntries() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS pi_session_entries (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      parent_id TEXT,
      entry_type TEXT NOT NULL,
      entry TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, entry_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pi_session_entries_session_seq
      ON pi_session_entries(session_id, seq);
  `);

  const sessionRows = sqlite.prepare("SELECT id FROM sessions ORDER BY created_at, id").all() as Array<{ id: string }>;
  const hasEntries = sqlite.prepare("SELECT 1 FROM pi_session_entries WHERE session_id = ? LIMIT 1");
  const readMessages = sqlite.prepare(
    "SELECT message, created_at FROM session_messages WHERE session_id = ? ORDER BY seq",
  );
  const insertEntry = sqlite.prepare(`
    INSERT INTO pi_session_entries
      (session_id, entry_id, seq, parent_id, entry_type, entry, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const session of sessionRows) {
    // A pre-existing Pi tree is authoritative. Never splice legacy rows into
    // a session that has already started using the native entry format.
    if (hasEntries.get(session.id)) continue;
    const messages = readMessages.all(session.id) as Array<{ message: string; created_at: number }>;
    let parentId: string | null = null;
    messages.forEach((row, seq) => {
      const entryId = id("pi_entry");
      const createdAt = Number.isFinite(row.created_at) ? row.created_at : now();
      const entry = {
        type: "message",
        id: entryId,
        parentId,
        timestamp: new Date(createdAt).toISOString(),
        message: JSON.parse(row.message) as unknown,
      };
      insertEntry.run(session.id, entryId, seq, parentId, entry.type, JSON.stringify(entry), createdAt);
      parentId = entryId;
    });
  }
}

// Manual host paths and mounts are privileged infrastructure configuration.
// Existing accounts predate roles and became admins in migration 009, so this
// only changes agents owned by accounts explicitly created as regular users.
function restrictNonAdminAgentHostPaths() {
  const rows = sqlite.prepare(`
    SELECT agents.id AS id
    FROM agents
    JOIN users ON users.id = agents.owner_user_id
    WHERE users.role <> 'admin'
      AND (agents.working_dir_mode = 'manual' OR agents.mounts <> '[]')
  `).all() as Array<{ id: string }>;
  const update = sqlite.prepare(`
    UPDATE agents
    SET working_dir_mode = 'default',
        working_dir = ?,
        default_working_dir = ?,
        mounts = '[]',
        updated_at = ?
    WHERE id = ?
  `);
  for (const row of rows) {
    const workingDir = defaultAgentWorkingDir(row.id);
    update.run(workingDir, workingDir, now(), row.id);
  }
}

function dropCustomHeaders() {
  dropColumnIfExists("model_refs", "custom_headers");
  dropColumnIfExists("provider_configs", "custom_headers");
}

function parseMessagesBlob(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function backfillModelOwners() {
  const timestamp = now();
  const configs = new Map(db.select().from(providerConfigs).all().map((config) => [config.id, config]));
  const fallbackUserId = db.select().from(users).all()[0]?.id ?? defaultUser.id;
  for (const model of db.select().from(modelRefs).all()) {
    if (model.ownerUserId) continue;
    const ownerUserId = model.providerConfigId ? (configs.get(model.providerConfigId)?.userId ?? fallbackUserId) : fallbackUserId;
    db.update(modelRefs)
      .set({ ownerUserId, updatedAt: timestamp })
      .where(eq(modelRefs.id, model.id))
      .run();
  }
}

function normalizeDefaultAgentWorkingDirs() {
  const timestamp = now();
  for (const agent of db.select().from(agents).all()) {
    if (agent.workingDirMode !== "default") continue;
    const workingDir = normalizeDataRelativePath(agent.workingDir || defaultAgentWorkingDir(agent.id));
    const defaultWorkingDir = normalizeDataRelativePath(agent.defaultWorkingDir ?? workingDir);
    if (workingDir === agent.workingDir && defaultWorkingDir === agent.defaultWorkingDir) continue;
    db.update(agents)
      .set({ workingDir, defaultWorkingDir, updatedAt: timestamp })
      .where(eq(agents.id, agent.id))
      .run();
  }
}

export function seed() {
  const [existing] = db.select({ value: count() }).from(users).all();
  if (existing?.value) {
    const [existingProviderConfigs] = db.select({ value: count() }).from(providerConfigs).all();
    if (!existingProviderConfigs?.value) {
      const timestamp = now();
      db.insert(providerConfigs)
        .values({ ...defaultProviderConfig, createdAt: timestamp, updatedAt: timestamp })
        .run();
      db.update(modelRefs)
        .set({ providerConfigId: defaultProviderConfig.id, updatedAt: timestamp })
        .where(eq(modelRefs.id, defaultModelRef.id))
        .run();
    }
    dropModelRefIndexes();
    backfillModelProviderConfigs();
    dedupeModelRefs();
    ensureModelRefIndexes();
    return;
  }

  const timestamp = now();
  db.insert(users)
    .values({ ...defaultUser, createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(providerConfigs)
    .values({ ...defaultProviderConfig, createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(modelRefs)
    .values({ ...defaultModelRef, input: defaultModelRef.input ?? ["text"], createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(agents)
    .values({ ...defaultAgent, createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(sessions)
    .values({ ...defaultSession, createdAt: timestamp, updatedAt: timestamp })
    .run();
  dropModelRefIndexes();
  backfillModelProviderConfigs();
  dedupeModelRefs();
  ensureModelRefIndexes();
}

function backfillModelProviderConfigs() {
  const configs = db.select().from(providerConfigs).all();
  const models = db.select().from(modelRefs).all();
  for (const model of models) {
    if (model.providerConfigId) continue;
    const matchingConfigs = configs.filter((config) => config.provider === model.provider);
    if (matchingConfigs.length !== 1) continue;
    db.update(modelRefs)
      .set({ providerConfigId: matchingConfigs[0].id, updatedAt: now() })
      .where(eq(modelRefs.id, model.id))
      .run();
  }
}

function dedupeModelRefs() {
  const allModels = db.select().from(modelRefs).all();
  const allAgents = db.select().from(agents).all();
  const allSessions = db.select().from(sessions).all();
  const groups = new Map<string, typeof allModels>();

  for (const model of allModels) {
    const key = model.providerConfigId
      ? `config:${model.providerConfigId}:${model.modelId}`
      : `provider:${model.provider}:${model.modelId}`;
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => {
      const aRefs =
        allAgents.filter((agent) => agent.defaultModelRefId === a.id).length +
        allSessions.filter((session) => session.modelRefId === a.id).length;
      const bRefs =
        allAgents.filter((agent) => agent.defaultModelRefId === b.id).length +
        allSessions.filter((session) => session.modelRefId === b.id).length;
      return bRefs - aRefs || a.createdAt - b.createdAt;
    });
    const keeper = ranked[0];
    for (const duplicate of ranked.slice(1)) {
      db.update(agents)
        .set({ defaultModelRefId: keeper.id, updatedAt: now() })
        .where(eq(agents.defaultModelRefId, duplicate.id))
        .run();
      db.update(sessions)
        .set({ modelRefId: keeper.id, updatedAt: now() })
        .where(eq(sessions.modelRefId, duplicate.id))
        .run();
      db.delete(modelRefs).where(eq(modelRefs.id, duplicate.id)).run();
    }
  }
}

function ensureModelRefIndexes() {
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS model_refs_provider_config_model_unique
      ON model_refs(provider_config_id, model_id)
      WHERE provider_config_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS model_refs_provider_model_unique
      ON model_refs(provider, model_id)
      WHERE provider_config_id IS NULL;
  `);
}

function dropModelRefIndexes() {
  sqlite.exec(`
    DROP INDEX IF EXISTS model_refs_provider_config_model_unique;
    DROP INDEX IF EXISTS model_refs_provider_model_unique;
  `);
}

function addUserRoles() {
  addColumnIfMissing("users", "role", "TEXT NOT NULL DEFAULT 'user'");
  // Accounts that already existed were provisioned by the operator, so keep their
  // access by promoting them to admin. Runs once; on a fresh database there are
  // no users yet (seed runs after migrate), so this is a no-op.
  sqlite.exec("UPDATE users SET role = 'admin'");
}

function addColumnIfMissing(table: string, column: string, type: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function dropColumnIfExists(table: string, column: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
