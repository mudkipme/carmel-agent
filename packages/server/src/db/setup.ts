import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { upgradeLegacySchema } from "./legacy-upgrade.ts";

export function initializeSchema(sqlite: BetterSqlite3.Database) {
  const hasTable = (name: string) =>
    Boolean(
      sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    );
  const migrated =
    hasTable("__drizzle_migrations") &&
    sqlite.prepare("SELECT 1 FROM __drizzle_migrations LIMIT 1").get();
  if (!migrated && hasTable("users")) upgradeLegacySchema(sqlite);
  migrate(drizzle(sqlite), {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
}
