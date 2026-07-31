import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { dataDir, ensureParentDir } from "../paths.ts";
import { runMigrations } from "./migrations.ts";
import { seedDatabase } from "./seed.ts";

const databaseUrl = process.env.DATABASE_URL ?? `${dataDir}/carmel-agent.sqlite`;
const databasePath = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;

ensureParentDir(databasePath);

export const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

export function migrate() {
  runMigrations(sqlite);
}

export function seed() {
  seedDatabase(sqlite);
}
