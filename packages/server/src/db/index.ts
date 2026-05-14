import Database from "better-sqlite3";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agents, modelRefs, providerConfigs, sessions, users } from "./schema";
import { defaultAgent, defaultModelRef, defaultProviderConfig, defaultSession, defaultUser, now } from "./seed";

const defaultDatabaseUrl = fileURLToPath(new URL("../../../../data/carmel-agent.sqlite", import.meta.url));
const databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl;
const databasePath = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;

mkdirSync(dirname(resolve(databasePath)), { recursive: true });

export const sqlite = new Database(databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

export function migrate() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_refs (
      id TEXT PRIMARY KEY NOT NULL,
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
      custom_headers TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_configs (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      label TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key TEXT,
      base_url TEXT,
      custom_headers TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY NOT NULL,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      shared INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      skills TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      prompt_templates TEXT NOT NULL,
      permissions TEXT NOT NULL,
      default_model_ref_id TEXT NOT NULL REFERENCES model_refs(id),
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
      messages TEXT NOT NULL,
      forked_from TEXT,
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
  addColumnIfMissing("model_refs", "provider_config_id", "TEXT");
}

export function seed() {
  const [existing] = db.select({ value: count() }).from(users).all();
  if (existing?.value) {
    const [existingProviderConfigs] = db.select({ value: count() }).from(providerConfigs).all();
    if (!existingProviderConfigs?.value) {
      const timestamp = now();
      db.insert(providerConfigs)
        .values({ ...defaultProviderConfig, createdAt: timestamp, updatedAt: timestamp })
        .run();
      db.update(modelRefs)
        .set({ providerConfigId: defaultProviderConfig.id, updatedAt: timestamp })
        .where(eq(modelRefs.id, defaultModelRef.id))
        .run();
    }
    dropModelRefIndexes();
    backfillModelProviderConfigs();
    dedupeModelRefs();
    ensureModelRefIndexes();
    return;
  }

  const timestamp = now();
  db.insert(users)
    .values({ ...defaultUser, createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(providerConfigs)
    .values({ ...defaultProviderConfig, createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(modelRefs)
    .values({ ...defaultModelRef, input: defaultModelRef.input ?? ["text"], createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(agents)
    .values({ ...defaultAgent, createdAt: timestamp, updatedAt: timestamp })
    .run();
  db.insert(sessions)
    .values({ ...defaultSession, createdAt: timestamp, updatedAt: timestamp })
    .run();
  dropModelRefIndexes();
  backfillModelProviderConfigs();
  dedupeModelRefs();
  ensureModelRefIndexes();
}

function backfillModelProviderConfigs() {
  const configs = db.select().from(providerConfigs).all();
  const models = db.select().from(modelRefs).all();
  for (const model of models) {
    if (model.providerConfigId) continue;
    const matchingConfigs = configs.filter((config) => config.provider === model.provider);
    if (matchingConfigs.length !== 1) continue;
    db.update(modelRefs)
      .set({ providerConfigId: matchingConfigs[0].id, updatedAt: now() })
      .where(eq(modelRefs.id, model.id))
      .run();
  }
}

function dedupeModelRefs() {
  const allModels = db.select().from(modelRefs).all();
  const allAgents = db.select().from(agents).all();
  const allSessions = db.select().from(sessions).all();
  const groups = new Map<string, typeof allModels>();

  for (const model of allModels) {
    const key = model.providerConfigId
      ? `config:${model.providerConfigId}:${model.modelId}`
      : `provider:${model.provider}:${model.modelId}`;
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => {
      const aRefs =
        allAgents.filter((agent) => agent.defaultModelRefId === a.id).length +
        allSessions.filter((session) => session.modelRefId === a.id).length;
      const bRefs =
        allAgents.filter((agent) => agent.defaultModelRefId === b.id).length +
        allSessions.filter((session) => session.modelRefId === b.id).length;
      return bRefs - aRefs || a.createdAt - b.createdAt;
    });
    const keeper = ranked[0];
    for (const duplicate of ranked.slice(1)) {
      db.update(agents)
        .set({ defaultModelRefId: keeper.id, updatedAt: now() })
        .where(eq(agents.defaultModelRefId, duplicate.id))
        .run();
      db.update(sessions)
        .set({ modelRefId: keeper.id, updatedAt: now() })
        .where(eq(sessions.modelRefId, duplicate.id))
        .run();
      db.delete(modelRefs).where(eq(modelRefs.id, duplicate.id)).run();
    }
  }
}

function ensureModelRefIndexes() {
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS model_refs_provider_config_model_unique
      ON model_refs(provider_config_id, model_id)
      WHERE provider_config_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS model_refs_provider_model_unique
      ON model_refs(provider, model_id)
      WHERE provider_config_id IS NULL;
  `);
}

function dropModelRefIndexes() {
  sqlite.exec(`
    DROP INDEX IF EXISTS model_refs_provider_config_model_unique;
    DROP INDEX IF EXISTS model_refs_provider_model_unique;
  `);
}

function addColumnIfMissing(table: string, column: string, type: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function touchSession(sessionId: string) {
  db.update(sessions).set({ updatedAt: now() }).where(eq(sessions.id, sessionId)).run();
}
