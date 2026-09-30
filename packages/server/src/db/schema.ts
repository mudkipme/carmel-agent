import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ActivityKind } from "@carmel-agent/shared";
import type { Api, Credential, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type {
  AgentMount,
  AgentMcpServer,
  AgentPermissions,
  AgentTaskOutcome,
  AgentTaskRunOutcome,
  AgentTaskStatus,
  AgentRunOutcome,
  AgentThinkingLevel,
  AgentWorkingDirMode,
  IssueStatus,
  IssueVerdict,
  PromptTemplate,
  Session,
  TaskScheduleKind,
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
  (table) => [primaryKey({ columns: [table.issuer, table.subject] })],
);

/**
 * A per-user bearer token for the OpenAI-compatible `/v1` endpoint.
 *
 * Only a SHA-256 of the key is stored: the plaintext is shown once, when the
 * key is created. Keys are random 32-byte values, so a fast unsalted hash is
 * enough -- there is no low-entropy secret here for a slow hash to protect.
 * `prefix` is the start of the plaintext, kept so a list of keys can say which
 * one is which.
 */
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  lastUsedAt: integer("last_used_at"),
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
  codemodeEnabled: integer("codemode_enabled", { mode: "boolean" }).notNull().default(false),
  mcpServers: text("mcp_servers", { mode: "json" }).$type<AgentMcpServer[]>().notNull().default([]),
  defaultModelRefId: text("default_model_ref_id")
    .notNull()
    .references(() => modelRefs.id),
  defaultThinkingLevel: text("default_thinking_level").$type<AgentThinkingLevel>().notNull().default("off"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Environment variables exported into an agent's sandbox container.
 *
 * A table rather than a column on `agents` for one reason: `serializeAgentSettings`
 * spreads the agent row, so a column here would be a secret one refactor away
 * from the browser. Keeping values in their own table means the agent endpoints
 * cannot leak them even by accident.
 *
 * Keyed by agent, not by (agent, user): a shared agent carries its owner's
 * secrets to whoever runs it, exactly as its mounts already do.
 */
export const agentSecrets = sqliteTable(
  "agent_secrets",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    name: text("name").notNull(),
    /** Encrypted with `protectSecret` when CARMEL_SECRET_KEY is set. */
    value: text("value").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.name] })],
);

/**
 * A prompt an agent runs on a schedule.
 *
 * Belongs to an agent and dies with it. `userId` is still needed even so:
 * agents can be shared, and the dedicated session, the model permission check,
 * and the provider credentials all resolve per user rather than per agent.
 */
export const agentTasks = sqliteTable("agent_tasks", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  /** Null falls back to the agent's defaults at fire time, not at write time. */
  modelRefId: text("model_ref_id"),
  thinkingLevel: text("thinking_level").$type<AgentThinkingLevel>(),
  scheduleKind: text("schedule_kind").$type<TaskScheduleKind>().notNull(),
  scheduleValue: text("schedule_value").notNull(),
  timezone: text("timezone"),
  status: text("status").$type<AgentTaskStatus>().notNull().default("active"),
  nextRunAt: integer("next_run_at"),
  lastRunAt: integer("last_run_at"),
  lastOutcome: text("last_outcome").$type<AgentTaskOutcome>(),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** One row per firing, including the ones that did not run. */
export const agentTaskRuns = sqliteTable("agent_task_runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => agentTasks.id),
  scheduledFor: integer("scheduled_for").notNull(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  outcome: text("outcome").$type<AgentTaskRunOutcome>().notNull(),
  detail: text("detail"),
  /** The session this run prompted in. Null for firings that never ran. */
  sessionId: text("session_id"),
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
  /** Archived sessions leave the session list; they are restored or deleted from agent settings. */
  archivedAt: integer("archived_at"),
  /**
   * The task whose run created this session. Task-run sessions stay out of the
   * session list and are reached from the task's run history, until moved to
   * the list, which clears this.
   */
  taskId: text("task_id"),
  /** The issue this session works. Issue sessions are listed as issues, not as sessions. */
  issueId: text("issue_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Durable agent-owned brief. Running claims live in issue_attempts and are reconciled on boot. */
export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  sessionId: text("session_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status").$type<IssueStatus>().notNull().default("todo"),
  criteria: text("criteria", { mode: "json" }).$type<string[]>().notNull().default([]),
  priority: text("priority").$type<import("@carmel-agent/shared").IssuePriority>().notNull().default("normal"),
  lastRunOutcome: text("last_run_outcome").$type<AgentRunOutcome>(),
  lastRunDetail: text("last_run_detail"),
  verdict: text("verdict").$type<IssueVerdict>(),
  verdictSummary: text("verdict_summary"),
  closedAt: integer("closed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const issueAttempts = sqliteTable("issue_attempts", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
  instructions: text("instructions").notNull(),
  brief: text("brief").notNull(),
  outcome: text("outcome").$type<AgentRunOutcome | "running">().notNull(),
  summary: text("summary"),
  evidence: text("evidence"),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
});
export const issueNotes = sqliteTable("issue_notes", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"note" | "action" | "result">().notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const activity = sqliteTable("activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventKey: text("event_key").notNull().unique(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
  issueId: text("issue_id").references(() => issues.id, { onDelete: "cascade" }),
  taskId: text("task_id").references(() => agentTasks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  kind: text("kind").$type<ActivityKind>().notNull(),
  createdAt: integer("created_at").notNull(),
  readAt: integer("read_at"),
});
