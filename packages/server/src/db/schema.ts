import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Api, Credential, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type {
  AgentMount,
  AgentPermissions,
  AgentThinkingLevel,
  AgentWorkingDirMode,
  PromptTemplate,
  Session,
  UserRole,
} from "@carmel-agent/shared";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username"),
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").$type<UserRole>().notNull().default("user"),
  fastTaskModelRefId: text("fast_task_model_ref_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const modelRefs = sqliteTable("model_refs", {
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
});

export const providerConfigs = sqliteTable("provider_configs", {
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
});

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

export const modelCatalogs = sqliteTable("model_catalogs", {
  providerId: text("provider_id").primaryKey(),
  models: text("models", { mode: "json" }).$type<Array<Model<Api>>>().notNull(),
  checkedAt: integer("checked_at"),
  lastModified: integer("last_modified"),
  etag: text("etag"),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id),
  shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  name: text("name").notNull(),
  description: text("description").notNull(),
  workingDirMode: text("working_dir_mode").$type<AgentWorkingDirMode>().notNull().default("manual"),
  workingDir: text("working_dir").notNull(),
  defaultWorkingDir: text("default_working_dir"),
  mounts: text("mounts", { mode: "json" }).$type<AgentMount[]>().notNull().default([]),
  systemPrompt: text("system_prompt").notNull(),
  promptTemplates: text("prompt_templates", { mode: "json" }).$type<PromptTemplate[]>().notNull(),
  permissions: text("permissions", { mode: "json" }).$type<AgentPermissions>().notNull(),
  /**
   * Extension providers this agent may use, by provider id.
   *
   * Opt-in per agent, and only ever meaningful for extensions -- built-in tool
   * providers ignore it, so an empty list is the safe default rather than an
   * agent with no tools. An administrator installs an extension instance-wide;
   * this is the second decision, made per agent.
   */
  enabledExtensions: text("enabled_extensions", { mode: "json" }).$type<string[]>().notNull().default([]),
  defaultModelRefId: text("default_model_ref_id")
    .notNull()
    .references(() => modelRefs.id),
  defaultThinkingLevel: text("default_thinking_level").$type<AgentThinkingLevel>().notNull().default("off"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  modelRefId: text("model_ref_id")
    .notNull()
    .references(() => modelRefs.id),
  thinkingLevel: text("thinking_level").$type<Session["thinkingLevel"]>().notNull(),
  revision: integer("revision").notNull().default(0),
  forkedFrom: text("forked_from", { mode: "json" }).$type<Session["forkedFrom"]>(),
  pinnedAt: integer("pinned_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
