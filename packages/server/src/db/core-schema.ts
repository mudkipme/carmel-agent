import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  AgentColor,
  AgentIcon,
  AgentMcpServer,
  AgentMount,
  AgentPermissions,
  AgentThinkingLevel,
  PromptTemplate,
  UserRole,
} from "@carmel-agent/shared";
import type { Credential, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username"),
    passwordHash: text("password_hash"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<UserRole>().notNull().default("user"),
    fastTaskModelRefId: text("fast_task_model_ref_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("users_fast_task_model_ref_id").on(table.fastTaskModelRefId),
    uniqueIndex("users_username_unique")
      .on(table.username)
      .where(sql`${table.username} IS NOT NULL`),
  ],
);

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * An OpenID Connect identity linked to a local account.
 *
 * Keyed by (issuer, subject) because `sub` is the only claim a provider
 * promises never to reassign: usernames and emails are only consulted once,
 * to find the account a brand-new identity belongs to. After that the link is
 * what signs the person in, so renaming them at the provider cannot move them
 * onto somebody else's account.
 */
export const userIdentities = sqliteTable(
  "user_identities",
  {
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    lastLoginAt: integer("last_login_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.issuer, table.subject] }),
    index("user_identities_user").on(table.userId),
  ],
);

/**
 * A per-user bearer token for the OpenAI-compatible `/api/v1` endpoint.
 *
 * Only a SHA-256 of the key is stored: the plaintext is shown once, when the
 * key is created. Keys are random 32-byte values, so a fast unsalted hash is
 * enough -- there is no low-entropy secret here for a slow hash to protect.
 * `prefix` is the start of the plaintext, kept so a list of keys can say which
 * one is which.
 */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("api_keys_user").on(table.userId)],
);

export const modelRefs = sqliteTable(
  "model_refs",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    label: text("label").notNull(),
    provider: text("provider").notNull(),
    providerConfigId: text("provider_config_id"),
    modelId: text("model_id").notNull(),
    api: text("api"),
    baseUrl: text("base_url"),
    contextWindow: integer("context_window"),
    maxTokens: integer("max_tokens"),
    reasoning: integer("reasoning", { mode: "boolean" }).notNull().default(false),
    input: text("input", { mode: "json" }).$type<Array<"text" | "image">>().notNull(),
    thinkingLevelMap: text("thinking_level_map", { mode: "json" }).$type<ThinkingLevelMap>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("model_refs_owner_user_id").on(table.ownerUserId),
    index("model_refs_provider_config_id").on(table.providerConfigId),
    uniqueIndex("model_refs_provider_config_model_unique")
      .on(table.providerConfigId, table.modelId)
      .where(sql`${table.providerConfigId} IS NOT NULL`),
    uniqueIndex("model_refs_provider_model_unique")
      .on(table.provider, table.modelId)
      .where(sql`${table.providerConfigId} IS NULL`),
  ],
);

export const providerConfigs = sqliteTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    label: text("label").notNull(),
    provider: text("provider").notNull(),
    authType: text("auth_type").$type<"api_key" | "oauth">().notNull().default("api_key"),
    apiKey: text("api_key"),
    oauthCredential: text("oauth_credential", { mode: "json" }).$type<Credential>(),
    baseUrl: text("base_url"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("provider_configs_user_id").on(table.userId)],
);

export const providerKeys = sqliteTable(
  "provider_keys",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    apiKey: text("api_key").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
);

/**
 * Where agents run, like a machine they share: a `/workspace` holding each
 * agent's default folder, extra mounts, the runner's persistent home and
 * scratch under `storageDir`, its secrets, and its network. All of its agents
 * share a single runner container.
 */
export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** Data-relative directory holding `workspace/`, `home/` and `tmp/`. */
    storageDir: text("storage_dir").notNull(),
    mounts: text("mounts", { mode: "json" }).$type<AgentMount[]>().notNull().default([]),
    network: integer("network", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("environments_owner_user_id").on(table.ownerUserId)],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    name: text("name").notNull(),
    icon: text("icon").$type<AgentIcon>().notNull().default("bot"),
    color: text("color").$type<AgentColor>(),
    description: text("description").notNull(),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    /** Runner path inside one of the environment's mounts; empty for the default folder. */
    workingDir: text("working_dir").notNull().default(""),
    systemPrompt: text("system_prompt").notNull(),
    promptTemplates: text("prompt_templates", { mode: "json" }).$type<PromptTemplate[]>().notNull(),
    permissions: text("permissions", { mode: "json" }).$type<AgentPermissions>().notNull(),
    codemodeEnabled: integer("codemode_enabled", { mode: "boolean" }).notNull().default(false),
    mcpServers: text("mcp_servers", { mode: "json" })
      .$type<AgentMcpServer[]>()
      .notNull()
      .default([]),
    defaultModelRefId: text("default_model_ref_id")
      .notNull()
      .references(() => modelRefs.id),
    defaultThinkingLevel: text("default_thinking_level")
      .$type<AgentThinkingLevel>()
      .notNull()
      .default("off"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("agents_default_model_ref_id").on(table.defaultModelRefId),
    index("agents_environment_id").on(table.environmentId),
    index("agents_owner_user_id").on(table.ownerUserId),
  ],
);
