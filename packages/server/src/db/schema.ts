import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { Credential } from "@earendil-works/pi-ai";
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

export const sessionMessages = sqliteTable(
  "session_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    message: text("message", { mode: "json" }).$type<AgentMessage>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("session_messages_session_seq").on(table.sessionId, table.seq)],
);

/**
 * Native Pi session-tree entries. `session_messages` is intentionally retained
 * as a rollback copy for databases migrated from Carmel's former flat
 * transcript format.
 */
export const piSessionEntries = sqliteTable(
  "pi_session_entries",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    entryId: text("entry_id").notNull(),
    seq: integer("seq").notNull(),
    parentId: text("parent_id"),
    entryType: text("entry_type").$type<SessionTreeEntry["type"]>().notNull(),
    entry: text("entry", { mode: "json" }).$type<SessionTreeEntry>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.entryId] }),
    uniqueIndex("pi_session_entries_session_seq").on(table.sessionId, table.seq),
  ],
);
