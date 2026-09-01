import type BetterSqlite3 from "better-sqlite3";
import { defaultAgentWorkingDir, normalizeDataRelativePath } from "../paths.ts";

type Sqlite = BetterSqlite3.Database;
type Migration = {
  id: string;
  description: string;
  run: (sqlite: Sqlite) => void;
};

const migrationTimestamp = () => Date.now();

const migrations: Migration[] = [
  { id: "001_initial_schema", description: "Create base Carmel Agent tables", run: createBaseSchema },
  {
    id: "002_current_schema_compat",
    description: "Backfill legacy columns and current indexes",
    run: applyCurrentSchemaCompatibility,
  },
  { id: "003_session_pins", description: "Add session pin metadata", run: addSessionPins },
  { id: "004_drop_agent_skills", description: "Remove the global skill selection column", run: dropAgentSkills },
  { id: "005_agent_mounts", description: "Add per-agent additional runner mounts", run: addAgentMounts },
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
  { id: "009_user_roles", description: "Add user roles; existing accounts become admins", run: addUserRoles },
  {
    id: "011_restrict_host_paths",
    description: "Move non-admin agents off privileged host paths and mounts",
    run: restrictNonAdminAgentHostPaths,
  },
  {
    id: "012_session_revisions",
    description: "Add optimistic revisions for active-run lease protection",
    run: addSessionRevisions,
  },
  {
    id: "013_drop_legacy_session_storage",
    description: "Drop obsolete Carmel-owned session storage tables",
    run: dropLegacySessionStorage,
  },
  {
    id: "014_model_ref_integrity",
    description: "Backfill provider links, deduplicate models, and create uniqueness indexes",
    run: repairModelRefIntegrity,
  },
  {
    id: "015_model_catalog_cache",
    description: "Create the persistent Pi model catalog cache",
    run: createModelCatalogCache,
  },
  {
    id: "016_model_thinking_level_map",
    description: "Add per-model thinking level mapping so xhigh/max can be offered",
    run: addModelThinkingLevelMap,
  },
  {
    id: "017_agent_enabled_extensions",
    description: "Add the per-agent allowlist of admin-installed extension providers",
    run: addAgentEnabledExtensions,
  },
  {
    id: "018_agent_tasks",
    description: "Create scheduled agent tasks and their run log",
    run: createAgentTasks,
  },
  {
    id: "019_agent_secrets",
    description: "Create per-agent sandbox environment secrets",
    run: createAgentSecrets,
  },
];

export function runMigrations(sqlite: Sqlite) {
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
      migration.run(sqlite);
      sqlite
        .prepare("INSERT INTO schema_migrations (id, description, applied_at) VALUES (?, ?, ?)")
        .run(migration.id, migration.description, migrationTimestamp());
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function createBaseSchema(sqlite: Sqlite) {
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
      revision INTEGER NOT NULL DEFAULT 0,
      forked_from TEXT,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
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

function applyCurrentSchemaCompatibility(sqlite: Sqlite) {
  addColumnIfMissing(sqlite, "users", "username", "TEXT");
  addColumnIfMissing(sqlite, "users", "password_hash", "TEXT");
  addColumnIfMissing(sqlite, "users", "fast_task_model_ref_id", "TEXT");
  addColumnIfMissing(sqlite, "model_refs", "owner_user_id", "TEXT");
  addColumnIfMissing(sqlite, "model_refs", "shared", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(sqlite, "model_refs", "provider_config_id", "TEXT");
  addColumnIfMissing(sqlite, "provider_configs", "auth_type", "TEXT NOT NULL DEFAULT 'api_key'");
  addColumnIfMissing(sqlite, "provider_configs", "oauth_credential", "TEXT");
  addColumnIfMissing(sqlite, "agents", "working_dir_mode", "TEXT NOT NULL DEFAULT 'manual'");
  addColumnIfMissing(sqlite, "agents", "default_working_dir", "TEXT");
  addColumnIfMissing(sqlite, "agents", "default_thinking_level", "TEXT NOT NULL DEFAULT 'off'");
  addColumnIfMissing(sqlite, "sessions", "pinned_at", "INTEGER");
  backfillModelOwners(sqlite);
  normalizeDefaultAgentWorkingDirs(sqlite);
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL");
}

function addSessionPins(sqlite: Sqlite) {
  addColumnIfMissing(sqlite, "sessions", "pinned_at", "INTEGER");
}

function addSessionRevisions(sqlite: Sqlite) {
  addColumnIfMissing(sqlite, "sessions", "revision", "INTEGER NOT NULL DEFAULT 0");
}

function dropAgentSkills(sqlite: Sqlite) {
  dropColumnIfExists(sqlite, "agents", "skills");
}

function addAgentMounts(sqlite: Sqlite) {
  addColumnIfMissing(sqlite, "agents", "mounts", "TEXT NOT NULL DEFAULT '[]'");
}

function createAccessIndexes(sqlite: Sqlite) {
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

function restrictNonAdminAgentHostPaths(sqlite: Sqlite) {
  const rows = sqlite.prepare(`
    SELECT agents.id AS id FROM agents
    JOIN users ON users.id = agents.owner_user_id
    WHERE users.role <> 'admin' AND (agents.working_dir_mode = 'manual' OR agents.mounts <> '[]')
  `).all() as Array<{ id: string }>;
  const update = sqlite.prepare(`
    UPDATE agents SET working_dir_mode = 'default', working_dir = ?, default_working_dir = ?,
      mounts = '[]', updated_at = ? WHERE id = ?
  `);
  for (const row of rows) {
    const workingDir = defaultAgentWorkingDir(row.id);
    update.run(workingDir, workingDir, migrationTimestamp(), row.id);
  }
}

function dropCustomHeaders(sqlite: Sqlite) {
  dropColumnIfExists(sqlite, "model_refs", "custom_headers");
  dropColumnIfExists(sqlite, "provider_configs", "custom_headers");
}

function addUserRoles(sqlite: Sqlite) {
  addColumnIfMissing(sqlite, "users", "role", "TEXT NOT NULL DEFAULT 'user'");
  sqlite.exec("UPDATE users SET role = 'admin'");
}

function dropLegacySessionStorage(sqlite: Sqlite) {
  sqlite.exec("DROP TABLE IF EXISTS pi_session_entries; DROP TABLE IF EXISTS session_messages;");
}

function backfillModelOwners(sqlite: Sqlite) {
  const fallbackUserId = (sqlite.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as
    | { id: string }
    | undefined)?.id;
  if (!fallbackUserId) return;
  sqlite.prepare(`
    UPDATE model_refs SET owner_user_id = COALESCE(
      (SELECT user_id FROM provider_configs WHERE provider_configs.id = model_refs.provider_config_id),
      ?
    ), updated_at = ?
    WHERE owner_user_id IS NULL OR owner_user_id = ''
  `).run(fallbackUserId, migrationTimestamp());
}

function normalizeDefaultAgentWorkingDirs(sqlite: Sqlite) {
  const rows = sqlite.prepare(`
    SELECT id, working_dir AS workingDir, default_working_dir AS defaultWorkingDir
    FROM agents WHERE working_dir_mode = 'default'
  `).all() as Array<{ id: string; workingDir: string; defaultWorkingDir: string | null }>;
  const update = sqlite.prepare("UPDATE agents SET working_dir = ?, default_working_dir = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    const workingDir = normalizeDataRelativePath(row.workingDir || defaultAgentWorkingDir(row.id));
    const defaultWorkingDir = normalizeDataRelativePath(row.defaultWorkingDir ?? workingDir);
    if (workingDir !== row.workingDir || defaultWorkingDir !== row.defaultWorkingDir) {
      update.run(workingDir, defaultWorkingDir, migrationTimestamp(), row.id);
    }
  }
}

function repairModelRefIntegrity(sqlite: Sqlite) {
  const userCount = (sqlite.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
  const configCount = (sqlite.prepare("SELECT COUNT(*) AS count FROM provider_configs").get() as { count: number }).count;
  if (userCount > 0 && configCount === 0) {
    const timestamp = migrationTimestamp();
    const userId = (sqlite.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string }).id;
    const provider = (sqlite.prepare("SELECT provider FROM model_refs ORDER BY created_at LIMIT 1").get() as
      | { provider: string }
      | undefined)?.provider;
    if (provider) {
      sqlite.prepare(`
        INSERT INTO provider_configs
          (id, user_id, label, provider, auth_type, api_key, oauth_credential, base_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'api_key', NULL, NULL, ?, ?, ?)
      `).run("provider_default", userId, `${provider} migrated`, provider, null, timestamp, timestamp);
    }
  }

  const configs = sqlite.prepare("SELECT id, provider FROM provider_configs").all() as Array<{ id: string; provider: string }>;
  const models = sqlite.prepare(`
    SELECT id, provider, provider_config_id AS providerConfigId, model_id AS modelId, created_at AS createdAt
    FROM model_refs
  `).all() as Array<{ id: string; provider: string; providerConfigId: string | null; modelId: string; createdAt: number }>;
  const link = sqlite.prepare("UPDATE model_refs SET provider_config_id = ?, updated_at = ? WHERE id = ?");
  for (const model of models) {
    if (model.providerConfigId) continue;
    const matches = configs.filter((config) => config.provider === model.provider);
    if (matches.length === 1) link.run(matches[0]!.id, migrationTimestamp(), model.id);
  }

  sqlite.exec(`
    DROP INDEX IF EXISTS model_refs_provider_config_model_unique;
    DROP INDEX IF EXISTS model_refs_provider_model_unique;
  `);
  deduplicateModelRefs(sqlite);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS model_refs_provider_config_model_unique
      ON model_refs(provider_config_id, model_id) WHERE provider_config_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS model_refs_provider_model_unique
      ON model_refs(provider, model_id) WHERE provider_config_id IS NULL;
  `);
}

function addModelThinkingLevelMap(sqlite: Sqlite) {
  addColumnIfMissing(sqlite, "model_refs", "thinking_level_map", "TEXT");
}

function createModelCatalogCache(sqlite: Sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS model_catalogs (
      provider_id TEXT PRIMARY KEY NOT NULL,
      models TEXT NOT NULL,
      checked_at INTEGER,
      last_modified INTEGER,
      etag TEXT
    );
  `);
}

function deduplicateModelRefs(sqlite: Sqlite) {
  const models = sqlite.prepare(`
    SELECT id, provider, provider_config_id AS providerConfigId, model_id AS modelId, created_at AS createdAt
    FROM model_refs
  `).all() as Array<{ id: string; provider: string; providerConfigId: string | null; modelId: string; createdAt: number }>;
  const referenceCount = sqlite.prepare(`
    SELECT
      (SELECT COUNT(*) FROM agents WHERE default_model_ref_id = ?) +
      (SELECT COUNT(*) FROM sessions WHERE model_ref_id = ?) AS count
  `);
  const groups = new Map<string, typeof models>();
  for (const model of models) {
    const key = model.providerConfigId
      ? `config:${model.providerConfigId}:${model.modelId}`
      : `provider:${model.provider}:${model.modelId}`;
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  const updateAgents = sqlite.prepare("UPDATE agents SET default_model_ref_id = ?, updated_at = ? WHERE default_model_ref_id = ?");
  const updateSessions = sqlite.prepare("UPDATE sessions SET model_ref_id = ?, updated_at = ? WHERE model_ref_id = ?");
  const remove = sqlite.prepare("DELETE FROM model_refs WHERE id = ?");
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = group.map((model) => ({
      model,
      references: (referenceCount.get(model.id, model.id) as { count: number }).count,
    })).sort((left, right) => right.references - left.references || left.model.createdAt - right.model.createdAt);
    const keeper = ranked[0]!.model;
    for (const { model } of ranked.slice(1)) {
      const timestamp = migrationTimestamp();
      updateAgents.run(keeper.id, timestamp, model.id);
      updateSessions.run(keeper.id, timestamp, model.id);
      remove.run(model.id);
    }
  }
}

function createAgentTasks(sqlite: Sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model_ref_id TEXT,
      thinking_level TEXT,
      schedule_kind TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      timezone TEXT,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_outcome TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- The scheduler's only hot query: active tasks that are due.
    CREATE INDEX IF NOT EXISTS agent_tasks_due ON agent_tasks (status, next_run_at);
    CREATE INDEX IF NOT EXISTS agent_tasks_agent ON agent_tasks (agent_id);

    CREATE TABLE IF NOT EXISTS agent_task_runs (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id),
      scheduled_for INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      outcome TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_task_runs_task ON agent_task_runs (task_id, started_at DESC);
  `);
}

function createAgentSecrets(sqlite: Sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_secrets (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, name)
    );
  `);
}

// Existing agents get an empty allowlist: installing an extension must never
// retroactively arm agents that were created before it existed.
function addAgentEnabledExtensions(sqlite: Sqlite) {
  addColumnIfMissing(sqlite, "agents", "enabled_extensions", "TEXT NOT NULL DEFAULT '[]'");
}

function addColumnIfMissing(sqlite: Sqlite, table: string, column: string, type: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function dropColumnIfExists(sqlite: Sqlite, table: string, column: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) sqlite.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
