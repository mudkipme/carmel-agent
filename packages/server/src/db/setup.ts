import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolveDataPath } from "../paths.ts";
import { finishLegacyWorkspaces } from "./legacy-workspaces.ts";

/** `dataPath` resolves data-relative paths; tests point it away from the real data directory. */
export function initializeSchema(sqlite: BetterSqlite3.Database, dataPath = resolveDataPath) {
  // Migrations that rebuild a table drop the original. The migrator runs inside
  // a transaction, where `PRAGMA foreign_keys=OFF` is ignored, so with keys on
  // that drop would fire every ON DELETE CASCADE pointing at the table.
  const foreignKeys = sqlite.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeys) sqlite.pragma("foreign_keys = OFF");
  try {
    migrate(drizzle(sqlite), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
    });
  } finally {
    if (foreignKeys) sqlite.pragma("foreign_keys = ON");
  }
  finishLegacyWorkspaces(sqlite, dataPath);
  const violations = sqlite.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0)
    throw new Error(`Database migration left ${violations.length} foreign key violation(s).`);
}
