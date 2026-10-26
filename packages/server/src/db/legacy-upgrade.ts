import type BetterSqlite3 from "better-sqlite3";

export function upgradeLegacySchema(sqlite: BetterSqlite3.Database) {
  const columns = (table: string) =>
    (sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map(({ name }) => name);
  sqlite.transaction(() => {
    const secrets = columns("agent_secrets");
    if (secrets.length && !secrets.includes("id")) {
      sqlite.exec(`
        ALTER TABLE agent_secrets RENAME TO legacy_agent_secrets;
        CREATE TABLE agent_secrets (
          id TEXT PRIMARY KEY NOT NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id),
          session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
          name TEXT NOT NULL, value TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        INSERT INTO agent_secrets (id, agent_id, name, value, created_at, updated_at)
          SELECT lower(hex(randomblob(16))), agent_id, name, value, created_at, updated_at FROM legacy_agent_secrets;
        DROP TABLE legacy_agent_secrets;
      `);
    }
    for (const table of ["agent_tasks", "issues"])
      if (columns(table).length && !columns(table).includes("notify_platform"))
        sqlite.exec(`ALTER TABLE ${table} ADD COLUMN notify_platform TEXT`);
    if (columns("im_outbox").length && !columns("im_outbox").includes("home_event_id"))
      sqlite.exec("ALTER TABLE im_outbox ADD COLUMN home_event_id TEXT");
    const inbox = columns("im_inbox");
    if (inbox.length) {
      if (!inbox.includes("home_event_id"))
        sqlite.exec("ALTER TABLE im_inbox ADD COLUMN home_event_id TEXT");
      if (!inbox.includes("legacy")) {
        sqlite.exec("ALTER TABLE im_inbox ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
        sqlite.exec(
          "UPDATE im_inbox SET legacy = 1, session_id = COALESCE(session_id, (SELECT session_id FROM im_bindings WHERE integration_id = im_inbox.integration_id)) WHERE status IN ('queued', 'running')",
        );
      }
    }
  })();
}
