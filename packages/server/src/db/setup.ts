import type BetterSqlite3 from "better-sqlite3";

/** Create the current metadata schema. Existing tables and data are left intact. */
export function initializeSchema(sqlite: BetterSqlite3.Database) {
  sqlite.transaction(() => sqlite.exec(CURRENT_SCHEMA))();
}

const CURRENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS knowledge_configs (
    agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    status TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS knowledge_sources (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_sources_agent ON knowledge_sources(agent_id);
  CREATE TABLE IF NOT EXISTS knowledge_memories (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    revision TEXT NOT NULL,
    contributor_id TEXT NOT NULL,
    pending_content TEXT,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS knowledge_memories_agent ON knowledge_memories(agent_id);
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

  CREATE TABLE IF NOT EXISTS user_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL,
    PRIMARY KEY (issuer, subject)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL
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

  CREATE TABLE IF NOT EXISTS provider_keys (
    user_id TEXT NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider)
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
    updated_at INTEGER NOT NULL,
    thinking_level_map TEXT
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
    updated_at INTEGER NOT NULL,
    mcp_servers TEXT NOT NULL DEFAULT '[]',
    codemode_enabled INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agent_secrets (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, name)
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
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    task_id TEXT,
    issue_id TEXT
  );

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
    status TEXT NOT NULL DEFAULT 'active',
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_outcome TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_task_runs (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id),
    scheduled_for INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT NOT NULL,
    detail TEXT,
    session_id TEXT
  );

  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    last_run_outcome TEXT,
    last_run_detail TEXT,
    verdict TEXT,
    verdict_summary TEXT,
    closed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    criteria TEXT NOT NULL DEFAULT '[]',
    priority TEXT NOT NULL DEFAULT 'normal',
    queue_position INTEGER,
    queued_command TEXT
  );

  CREATE TABLE IF NOT EXISTS issue_attempts (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    instructions TEXT NOT NULL,
    brief TEXT NOT NULL,
    outcome TEXT NOT NULL,
    summary TEXT,
    evidence TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    snapshot TEXT
  );

  CREATE TABLE IF NOT EXISTS issue_notes (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivery TEXT,
    entry_id TEXT
  );

  CREATE TABLE IF NOT EXISTS model_catalogs (
    provider_id TEXT PRIMARY KEY NOT NULL,
    models TEXT NOT NULL,
    checked_at INTEGER,
    last_modified INTEGER,
    etag TEXT
  );

  CREATE INDEX IF NOT EXISTS agent_task_runs_task ON agent_task_runs (task_id, started_at DESC);

  CREATE INDEX IF NOT EXISTS agent_tasks_agent ON agent_tasks (agent_id);

  CREATE INDEX IF NOT EXISTS agent_tasks_due ON agent_tasks (status, next_run_at);

  CREATE INDEX IF NOT EXISTS agents_default_model_ref_id ON agents(default_model_ref_id);

  CREATE INDEX IF NOT EXISTS agents_owner_user_id ON agents(owner_user_id);

  CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id);

  CREATE INDEX IF NOT EXISTS issue_attempts_issue ON issue_attempts(issue_id, created_at);

  CREATE UNIQUE INDEX IF NOT EXISTS issue_attempts_running ON issue_attempts(issue_id) WHERE outcome = 'running';

  CREATE INDEX IF NOT EXISTS issue_notes_issue ON issue_notes(issue_id, created_at);

  CREATE INDEX IF NOT EXISTS issues_agent_user ON issues (agent_id, user_id);

  CREATE INDEX IF NOT EXISTS issues_queue ON issues(agent_id, status, queue_position);

  CREATE INDEX IF NOT EXISTS model_refs_owner_user_id ON model_refs(owner_user_id);

  CREATE INDEX IF NOT EXISTS model_refs_provider_config_id ON model_refs(provider_config_id);

  CREATE UNIQUE INDEX IF NOT EXISTS model_refs_provider_config_model_unique ON model_refs(provider_config_id, model_id) WHERE provider_config_id IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS model_refs_provider_model_unique ON model_refs(provider, model_id) WHERE provider_config_id IS NULL;

  CREATE INDEX IF NOT EXISTS provider_configs_user_id ON provider_configs(user_id);

  CREATE INDEX IF NOT EXISTS sessions_agent_id ON sessions(agent_id);

  CREATE INDEX IF NOT EXISTS sessions_issue ON sessions (issue_id);

  CREATE INDEX IF NOT EXISTS sessions_model_ref_id ON sessions(model_ref_id);

  CREATE INDEX IF NOT EXISTS sessions_task ON sessions (task_id);

  CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

  CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities (user_id);

  CREATE INDEX IF NOT EXISTS users_fast_task_model_ref_id ON users(fast_task_model_ref_id);

  CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL;
`;
