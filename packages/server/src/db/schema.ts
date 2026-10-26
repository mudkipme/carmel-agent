import { imIntegrations } from "./im-schema.ts";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { desc, sql } from "drizzle-orm";
import type { KnowledgeSettings, KnowledgeStatus } from "@carmel-agent/shared";
import type { Credential, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type {
  AgentMount,
  AgentIcon,
  AgentColor,
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
    workingDirMode: text("working_dir_mode")
      .$type<AgentWorkingDirMode>()
      .notNull()
      .default("manual"),
    workingDir: text("working_dir").notNull(),
    defaultWorkingDir: text("default_working_dir"),
    mounts: text("mounts", { mode: "json" }).$type<AgentMount[]>().notNull().default([]),
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
    index("agents_owner_user_id").on(table.ownerUserId),
  ],
);

export const knowledgeConfigs = sqliteTable("knowledge_configs", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  settings: text("settings", { mode: "json" }).$type<KnowledgeSettings>().notNull(),
  status: text("status", { mode: "json" }).$type<KnowledgeStatus>().notNull(),
  dirty: integer("dirty", { mode: "boolean" }).notNull().default(true),
});
export const knowledgeSources = sqliteTable(
  "knowledge_sources",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    path: text("path").notNull(),
    description: text("description").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("knowledge_sources_agent").on(table.agentId)],
);
export const knowledgeMemories = sqliteTable(
  "knowledge_memories",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    revision: text("revision").notNull(),
    contributorId: text("contributor_id").notNull(),
    pendingContent: text("pending_content"),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("knowledge_memories_agent").on(table.agentId)],
);

/**
 * Environment variables exported into an agent's sandbox container.
 *
 * A table rather than a column on `agents` for one reason: `serializeAgentSettings`
 * spreads the agent row, so a column here would be a secret one refactor away
 * from the browser. Keeping values in their own table means the agent endpoints
 * cannot leak them even by accident.
 *
 * A null sessionId means an agent default, usable by its runners. A sessionId
 * restricts injection to that session and cascades deletion with it.
 */
export const agentSecrets = sqliteTable(
  "agent_secrets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Session submissions always require encryption; legacy agent settings retain their storage policy. */
    value: text("value").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_secrets_agent_name")
      .on(table.agentId, table.name)
      .where(sql`${table.sessionId} IS NULL`),
    uniqueIndex("agent_secrets_session_name")
      .on(table.sessionId, table.name)
      .where(sql`${table.sessionId} IS NOT NULL`),
  ],
);

/** Requests and safe answer receipts only. Secret values live exclusively in agent_secrets. */
export const userRequests = sqliteTable(
  "user_requests",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    callId: text("call_id").notNull(),
    kind: text("kind").$type<"question" | "secret">().notNull(),
    input: text("input", { mode: "json" })
      .$type<
        | import("@carmel-agent/shared").QuestionInput
        | import("@carmel-agent/shared").SecretRequestInput
      >()
      .notNull(),
    status: text("status")
      .$type<import("@carmel-agent/shared").UserRequest["status"]>()
      .notNull()
      .default("pending"),
    answer: text("answer", { mode: "json" }).$type<import("@carmel-agent/shared").QuestionAnswer>(),
    secretId: text("secret_id"),
    delivery: text("delivery").$type<"pending" | "submitted">(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("user_requests_call").on(table.sessionId, table.conversationId, table.callId),
    index("user_requests_session").on(table.sessionId, table.createdAt),
  ],
);

/**
 * A prompt an agent runs on a schedule.
 *
 * Belongs to an agent and dies with it. `userId` is still needed even so:
 * agents can be shared, and the dedicated session, the model permission check,
 * and the provider credentials all resolve per user rather than per agent.
 */
export const agentTasks = sqliteTable(
  "agent_tasks",
  {
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
    notifyPlatform: text("notify_platform").$type<import("@carmel-agent/shared").ImPlatform>(),
    status: text("status").$type<AgentTaskStatus>().notNull().default("active"),
    nextRunAt: integer("next_run_at"),
    lastRunAt: integer("last_run_at"),
    lastOutcome: text("last_outcome").$type<AgentTaskOutcome>(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("agent_tasks_agent").on(table.agentId),
    index("agent_tasks_due").on(table.status, table.nextRunAt),
  ],
);

/** One row per firing, including the ones that did not run. */
export const agentTaskRuns = sqliteTable(
  "agent_task_runs",
  {
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
  },
  (table) => [index("agent_task_runs_task").on(table.taskId, desc(table.startedAt))],
);

export const sessions = sqliteTable(
  "sessions",
  {
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
  },
  (table) => [
    index("sessions_agent_id").on(table.agentId),
    index("sessions_issue").on(table.issueId),
    index("sessions_model_ref_id").on(table.modelRefId),
    index("sessions_task").on(table.taskId),
    index("sessions_user_id").on(table.userId),
  ],
);

/** Durable agent-owned brief. Running claims live in issue_attempts and are reconciled on boot. */
export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    sessionId: text("session_id").notNull(),
    notifyPlatform: text("notify_platform").$type<import("@carmel-agent/shared").ImPlatform>(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status").$type<IssueStatus>().notNull().default("todo"),
    criteria: text("criteria", { mode: "json" }).$type<string[]>().notNull().default([]),
    priority: text("priority")
      .$type<import("@carmel-agent/shared").IssuePriority>()
      .notNull()
      .default("normal"),
    lastRunOutcome: text("last_run_outcome").$type<AgentRunOutcome>(),
    lastRunDetail: text("last_run_detail"),
    verdict: text("verdict").$type<IssueVerdict>(),
    verdictSummary: text("verdict_summary"),
    queuePosition: integer("queue_position"),
    queuedCommand: text("queued_command", { mode: "json" }).$type<
      import("@carmel-agent/shared").IssueRunCommand
    >(),
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("issues_agent_user").on(table.agentId, table.userId),
    index("issues_queue").on(table.agentId, table.status, table.queuePosition),
  ],
);

export const issueAttempts = sqliteTable(
  "issue_attempts",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    instructions: text("instructions").notNull(),
    brief: text("brief").notNull(),
    outcome: text("outcome").$type<AgentRunOutcome | "running">().notNull(),
    summary: text("summary"),
    evidence: text("evidence"),
    snapshot: text("snapshot", { mode: "json" }).$type<
      import("@carmel-agent/shared").IssueResultSnapshot
    >(),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("issue_attempts_issue").on(table.issueId, table.createdAt),
    uniqueIndex("issue_attempts_running")
      .on(table.issueId)
      .where(sql`${table.outcome} = 'running'`),
  ],
);
export const issueNotes = sqliteTable(
  "issue_notes",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"note" | "action" | "result">().notNull(),
    body: text("body").notNull(),
    delivery: text("delivery").$type<"queued" | "delivered" | "not_delivered">(),
    entryId: text("entry_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("issue_notes_issue").on(table.issueId, table.createdAt)],
);

export const agentHomes = sqliteTable(
  "agent_homes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .unique()
      .references(() => sessions.id),
    lastReadAt: integer("last_read_at").notNull().default(0),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const homeEvents = sqliteTable(
  "home_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull().unique(),
    kind: text("kind").notNull().default("input"),
    origin: text("origin").$type<"web" | "im" | "background">().notNull(),
    integrationId: text("integration_id").references(() => imIntegrations.id, {
      onDelete: "set null",
    }),
    prompt: text("prompt", { mode: "json" })
      .$type<import("@carmel-agent/shared").PromptInput>()
      .notNull(),
    status: text("status")
      .$type<"preparing" | "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted">()
      .notNull(),
    modelRefId: text("model_ref_id"),
    thinkingLevel: text("thinking_level").$type<AgentThinkingLevel>(),
    timezone: text("timezone"),
    runId: text("run_id"),
    reply: text("reply"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [index("home_events_queue").on(table.sessionId, table.status, table.createdAt)],
);

export const helperHosts = sqliteTable("helper_hosts", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  error: text("error"),
  updatedAt: integer("updated_at").notNull(),
});

export const modelCatalogs = sqliteTable("model_catalogs", {
  providerId: text("provider_id").primaryKey(),
  models: text("models", { mode: "json" }).notNull(),
  checkedAt: integer("checked_at"),
  lastModified: integer("last_modified"),
  etag: text("etag"),
});

export const sessionSearchState = sqliteTable("session_search_state", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
});
