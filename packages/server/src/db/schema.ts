import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AuthCredential } from "@earendil-works/pi-coding-agent";
import type {
  AgentPermissions,
  AgentThinkingLevel,
  AgentWorkingDirMode,
  PromptTemplate,
  Session,
} from "@carmel-agent/shared";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username"),
  passwordHash: text("password_hash"),
  name: text("name").notNull(),
  email: text("email").notNull(),
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
  customHeaders: text("custom_headers"),
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
  oauthCredential: text("oauth_credential", { mode: "json" }).$type<AuthCredential>(),
  baseUrl: text("base_url"),
  customHeaders: text("custom_headers"),
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
  skills: text("skills", { mode: "json" }).$type<string[]>().notNull(),
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
  messages: text("messages", { mode: "json" }).$type<Session["messages"]>().notNull(),
  forkedFrom: text("forked_from", { mode: "json" }).$type<Session["forkedFrom"]>(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
