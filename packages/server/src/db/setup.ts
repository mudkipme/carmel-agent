import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export function initializeSchema(sqlite: BetterSqlite3.Database) {
  migrate(drizzle(sqlite), {
    migrationsFolder: fileURLToPath(new URL("../../drizzle/", import.meta.url)),
  });
}
