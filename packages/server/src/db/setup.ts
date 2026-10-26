import type BetterSqlite3 from "better-sqlite3";

/** Create the current metadata schema. Existing tables and data are left intact. */
export function initializeSchema(sqlite: BetterSqlite3.Database) {
  sqlite.transaction(() => {
    sqlite.exec(CURRENT_SCHEMA);
    const secretColumns = sqlite.pragma("table_info(agent_secrets)") as Array<{ name: string }>;
    if (!secretColumns.some((column) => column.name === "id")) {
      sqlite.exec(`
        ALTER TABLE agent_secrets RENAME TO legacy_agent_secrets;
        ${SECRET_SCHEMA}
        INSERT INTO agent_secrets (id, agent_id, name, value, created_at, updated_at)
          SELECT lower(hex(randomblob(16))), agent_id, name, value, created_at, updated_at FROM legacy_agent_secrets;
        DROP TABLE legacy_agent_secrets;
      `);
    }
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_secrets_agent_name ON agent_secrets(agent_id, name) WHERE session_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS agent_secrets_session_name ON agent_secrets(session_id, name) WHERE session_id IS NOT NULL;
    `);
    const columns = sqlite.pragma("table_info(agent_tasks)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "notify_platform"))
      sqlite.exec("ALTER TABLE agent_tasks ADD COLUMN notify_platform TEXT");
    sqlite.exec(IM_SCHEMA);
    sqlite.exec(HOME_SCHEMA);
    const issueColumns = sqlite.pragma("table_info(issues)") as Array<{ name: string }>;
    if (!issueColumns.some((column) => column.name === "notify_platform"))
      sqlite.exec("ALTER TABLE issues ADD COLUMN notify_platform TEXT");
    sqlite.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(session_id UNINDEXED, entry_id UNINDEXED, text); CREATE TABLE IF NOT EXISTS session_search_state (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, revision INTEGER NOT NULL);`,
    );
    const outboxColumns = sqlite.pragma("table_info(im_outbox)") as Array<{ name: string }>;
    if (!outboxColumns.some((column) => column.name === "home_event_id"))
      sqlite.exec("ALTER TABLE im_outbox ADD COLUMN home_event_id TEXT");
    sqlite.exec(
      "CREATE TRIGGER IF NOT EXISTS session_search_delete AFTER DELETE ON sessions BEGIN DELETE FROM session_search WHERE session_id = OLD.id; END",
    );
    const inboxColumns = sqlite.pragma("table_info(im_inbox)") as Array<{ name: string }>;
    if (!inboxColumns.some((column) => column.name === "home_event_id")) {
      sqlite.exec("ALTER TABLE im_inbox ADD COLUMN home_event_id TEXT");
      sqlite.exec("ALTER TABLE im_inbox ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
      sqlite.exec(
        "UPDATE im_inbox SET legacy = 1, session_id = COALESCE(session_id, (SELECT session_id FROM im_bindings WHERE integration_id = im_inbox.integration_id)) WHERE status IN ('queued', 'running')",
      );
    }
  })();
}

const SECRET_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_secrets (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL, value TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);`;

const IM_SCHEMA = `
 CREATE TABLE IF NOT EXISTS im_integrations (
  id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform TEXT NOT NULL,
  bot_id TEXT NOT NULL, bot_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  proactive INTEGER NOT NULL DEFAULT 1, notification_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, error TEXT, offset INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
 );
 CREATE UNIQUE INDEX IF NOT EXISTS im_integrations_owner_platform ON im_integrations(agent_id, user_id, platform);
 CREATE UNIQUE INDEX IF NOT EXISTS im_integrations_bot ON im_integrations(platform, bot_id);
 CREATE TABLE IF NOT EXISTS im_credentials (
  integration_id TEXT PRIMARY KEY NOT NULL REFERENCES im_integrations(id) ON DELETE CASCADE, value TEXT NOT NULL
 );
 CREATE TABLE IF NOT EXISTS im_bindings (
  integration_id TEXT PRIMARY KEY NOT NULL REFERENCES im_integrations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_id TEXT
 );
 CREATE TABLE IF NOT EXISTS im_setup_attempts (
  id TEXT PRIMARY KEY NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform TEXT NOT NULL, status TEXT NOT NULL,
  state TEXT NOT NULL, bot_id TEXT, bot_name TEXT, offset INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, next_poll_at INTEGER NOT NULL, interval INTEGER NOT NULL DEFAULT 5000, error TEXT
 );
 CREATE INDEX IF NOT EXISTS im_setup_owner ON im_setup_attempts(agent_id, user_id);
 CREATE TABLE IF NOT EXISTS im_inbox (
  id TEXT PRIMARY KEY NOT NULL, integration_id TEXT NOT NULL REFERENCES im_integrations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL, prompt TEXT NOT NULL, image_keys TEXT NOT NULL DEFAULT '[]', message_id TEXT,
  status TEXT NOT NULL, session_id TEXT, run_id TEXT, created_at INTEGER NOT NULL
 );
 CREATE UNIQUE INDEX IF NOT EXISTS im_inbox_event ON im_inbox(integration_id, event_id);
 CREATE INDEX IF NOT EXISTS im_inbox_queue ON im_inbox(status, created_at);
 CREATE TABLE IF NOT EXISTS im_outbox (
  id TEXT PRIMARY KEY NOT NULL, integration_id TEXT NOT NULL REFERENCES im_integrations(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL UNIQUE, text TEXT NOT NULL, proactive INTEGER NOT NULL, session_id TEXT,
  status TEXT NOT NULL, provider_ids TEXT NOT NULL DEFAULT '[]', next_chunk INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL
 );
 CREATE INDEX IF NOT EXISTS im_outbox_pending ON im_outbox(status, next_attempt_at);
 CREATE INDEX IF NOT EXISTS im_outbox_session ON im_outbox(session_id);
`;

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

  ${SECRET_SCHEMA}

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

  CREATE TABLE IF NOT EXISTS user_requests (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL, call_id TEXT NOT NULL, kind TEXT NOT NULL,
    input TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', answer TEXT,
    secret_id TEXT, delivery TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS user_requests_call ON user_requests(session_id, conversation_id, call_id);
  CREATE INDEX IF NOT EXISTS user_requests_session ON user_requests(session_id, created_at);

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

const HOME_SCHEMA = `
 CREATE TABLE IF NOT EXISTS helper_hosts (
   session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
   error TEXT, updated_at INTEGER NOT NULL
 );

 CREATE TABLE IF NOT EXISTS home_events (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'input', origin TEXT NOT NULL,
  integration_id TEXT REFERENCES im_integrations(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL, status TEXT NOT NULL,
  model_ref_id TEXT, thinking_level TEXT, timezone TEXT,
  run_id TEXT, reply TEXT, error TEXT,
  created_at INTEGER NOT NULL, finished_at INTEGER
 );
 CREATE INDEX IF NOT EXISTS home_events_queue ON home_events(session_id, status, created_at);

 CREATE TABLE IF NOT EXISTS agent_homes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  last_read_at INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent_id)
 );
`;
