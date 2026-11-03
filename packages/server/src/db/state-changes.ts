import type Database from "better-sqlite3";
import type { StateTopic } from "@carmel-agent/shared";
import { publishStateChange } from "../state-changes.ts";

const tables: Record<string, StateTopic[]> = {
  users: ["workspace"],
  agents: ["workspace"],
  collaboration_connections: ["workspace"],
  collaborations: ["issues", "sessions"],
  collaboration_messages: ["sessions"],
  model_refs: ["workspace"],
  provider_configs: ["workspace"],
  provider_keys: ["workspace"],
  model_catalogs: ["workspace"],
  sessions: ["sessions", "homes"],
  helper_hosts: ["subtasks"],
  user_requests: ["sessions", "homes"],
  agent_homes: ["homes"],
  home_events: ["homes"],
  agent_tasks: ["tasks"],
  agent_task_runs: ["tasks"],
  issues: ["issues", "homes"],
  issue_attempts: ["issues"],
  issue_notes: ["issues"],
  knowledge_configs: ["knowledge"],
  knowledge_sources: ["knowledge"],
  knowledge_memories: ["knowledge"],
  im_integrations: ["integrations"],
  im_setup_attempts: ["integrations"],
  im_bindings: ["integrations"],
  im_inbox: ["integrations"],
  im_outbox: ["integrations", "homes"],
};

export function observeDatabaseChanges(sqlite: Database.Database) {
  sqlite.function("carmel_state_changed", (table: string) => {
    // Deliver after the synchronous statement or transaction has committed.
    publishStateChange(...tables[table]);
  });
  for (const table of Object.keys(tables)) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const changed = columns.map(({ name }) => `old."${name}" IS NOT new."${name}"`).join(" OR ");
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS carmel_updates_${table}_${operation}
        AFTER ${operation} ON main.${table}
        ${operation === "UPDATE" ? `WHEN ${changed}` : ""}
        BEGIN SELECT carmel_state_changed('${table}'); END;
      `);
    }
  }
}
