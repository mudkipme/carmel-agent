import type Database from "better-sqlite3";
import type { StateTopic } from "@carmel-agent/shared";
import { publishUserStateChange } from "../state-changes.ts";

type Row = "new" | "old";
type ObservedTable = { topics: StateTopic[]; owner?: (row: Row) => string };

const ownColumn = (row: Row) => `${row}.user_id`;
const ownerOf = (parent: string, column: string) => (row: Row) =>
  `(SELECT user_id FROM ${parent} WHERE id = ${row}.${column})`;

// Rows with an owner notify only that user. When the owner cannot be found,
// such as a child row deleted after its parent, everyone is notified.
const tables: Record<string, ObservedTable> = {
  users: { topics: ["workspace"] },
  agents: { topics: ["workspace"] },
  environments: { topics: ["workspace"] },
  collaboration_connections: { topics: ["workspace"] },
  collaborations: { topics: ["issues", "sessions"], owner: ownColumn },
  collaboration_messages: {
    topics: ["sessions"],
    owner: ownerOf("collaborations", "collaboration_id"),
  },
  model_refs: { topics: ["workspace"] },
  provider_configs: { topics: ["workspace"] },
  provider_keys: { topics: ["workspace"] },
  model_catalogs: { topics: ["workspace"] },
  sessions: { topics: ["sessions", "homes"], owner: ownColumn },
  helper_hosts: { topics: ["subtasks"], owner: ownerOf("sessions", "session_id") },
  user_requests: { topics: ["sessions", "homes"], owner: ownerOf("sessions", "session_id") },
  agent_homes: { topics: ["homes"], owner: ownColumn },
  home_events: { topics: ["homes"], owner: ownerOf("sessions", "session_id") },
  home_memory_settings: { topics: ["homes"], owner: ownColumn },
  home_memories: { topics: ["homes"], owner: ownColumn },
  agent_tasks: { topics: ["tasks"], owner: ownColumn },
  agent_task_runs: { topics: ["tasks"], owner: ownerOf("agent_tasks", "task_id") },
  issues: { topics: ["issues", "homes"], owner: ownColumn },
  issue_attempts: { topics: ["issues"], owner: ownerOf("issues", "issue_id") },
  issue_notes: { topics: ["issues"], owner: ownerOf("issues", "issue_id") },
  knowledge_configs: { topics: ["knowledge"] },
  knowledge_sources: { topics: ["knowledge"] },
  im_integrations: { topics: ["integrations"], owner: ownColumn },
  im_setup_attempts: { topics: ["integrations"], owner: ownColumn },
  im_bindings: { topics: ["integrations"], owner: ownerOf("im_integrations", "integration_id") },
  im_inbox: { topics: ["integrations"], owner: ownerOf("im_integrations", "integration_id") },
  im_outbox: {
    topics: ["integrations", "homes"],
    owner: ownerOf("im_integrations", "integration_id"),
  },
};

export function observeDatabaseChanges(sqlite: Database.Database) {
  sqlite.function("carmel_state_changed", (table: string, owner: string | null) => {
    // Deliver after the synchronous statement or transaction has committed.
    publishUserStateChange(owner, ...tables[table].topics);
  });
  for (const [table, { owner }] of Object.entries(tables)) {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const changed = columns.map(({ name }) => `old."${name}" IS NOT new."${name}"`).join(" OR ");
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const row: Row = operation === "DELETE" ? "old" : "new";
      sqlite.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS carmel_updates_${table}_${operation}
        AFTER ${operation} ON main.${table}
        ${operation === "UPDATE" ? `WHEN ${changed}` : ""}
        BEGIN SELECT carmel_state_changed('${table}', ${owner ? owner(row) : "NULL"}); END;
      `);
    }
  }
}
