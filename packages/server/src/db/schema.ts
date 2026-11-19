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
import type {
  HomeMemoryCaptureReport,
  HomeMemoryForgettingRule,
  HomeMemoryMode,
  HomeMemoryRevision,
  KnowledgeSettings,
  KnowledgeStatus,
  HomeIssueUpdate,
  AgentTaskOutcome,
  AgentTaskRunOutcome,
  AgentTaskStatus,
  AgentRunOutcome,
  AgentThinkingLevel,
  IssueStatus,
  IssueVerdict,
  Session,
  TaskScheduleKind,
} from "@carmel-agent/shared";
import { agents, environments, modelRefs, users } from "./core-schema.ts";

export {
  users,
  authSessions,
  userIdentities,
  apiKeys,
  modelRefs,
  providerConfigs,
  providerKeys,
  environments,
  agents,
} from "./core-schema.ts";

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

/**
 * Environment variables exported into an environment's sandbox container.
 *
 * A table rather than a column on `environments` for one reason: a serializer
 * that spreads the row would put a column here one refactor away from the
 * browser. Keeping values in their own table means those endpoints cannot leak
 * them even by accident.
 *
 * A null sessionId means an environment default, usable by every runner of its
 * agents. A sessionId restricts injection to that session and cascades
 * deletion with it.
 */
export const environmentSecrets = sqliteTable(
  "environment_secrets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Session submissions always require encryption; legacy settings retain their storage policy. */
    value: text("value").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environment_secrets_environment_name")
      .on(table.environmentId, table.name)
      .where(sql`${table.sessionId} IS NULL`),
    uniqueIndex("environment_secrets_session_name")
      .on(table.sessionId, table.name)
      .where(sql`${table.sessionId} IS NOT NULL`),
  ],
);

/** Requests and safe answer receipts only. Secret values live exclusively in environment_secrets. */
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
    collaborationId: text("collaboration_id"),
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
    collaborationId: text("collaboration_id"),
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
      .$type<
        import("@carmel-agent/shared").PromptInput & {
          issue?: HomeIssueUpdate;
          collaboration?: import("@carmel-agent/shared").CollaborationReply;
        }
      >()
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
    errorDismissedAt: integer("error_dismissed_at"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [index("home_events_queue").on(table.sessionId, table.status, table.createdAt)],
);

export const homeMemorySettings = sqliteTable(
  "home_memory_settings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    mode: text("mode").$type<HomeMemoryMode>().notNull().default("automatic"),
    retrieval: text("retrieval", { mode: "json" })
      .$type<KnowledgeSettings>()
      .notNull()
      .default({ enabled: false, acceleration: "auto" }),
    indexStatus: text("index_status", { mode: "json" }).$type<KnowledgeStatus>(),
    indexDirty: integer("index_dirty", { mode: "boolean" }).notNull().default(true),
    forgotten: text("forgotten", { mode: "json" })
      .$type<HomeMemoryForgettingRule[]>()
      .notNull()
      .default([]),
    generation: integer("generation").notNull().default(0),
    learnAfter: integer("learn_after").notNull().default(0),
    lastCaptureAt: integer("last_capture_at"),
    /** Diagnostics for the most recent learning call, including failures. */
    lastCapture: text("last_capture", { mode: "json" }).$type<HomeMemoryCaptureReport>(),
    calls: text("calls", { mode: "json" }).$type<number[]>().notNull().default([]),
    error: text("error"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const homeMemories = sqliteTable(
  "home_memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    scope: text("scope").notNull(),
    kind: text("kind").$type<"preference" | "fact" | "decision">().notNull(),
    placement: text("placement").$type<"core" | "topic">().notNull().default("topic"),
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default([]),
    title: text("title").notNull().default(""),
    contributorId: text("contributor_id"),
    slot: text("slot").notNull().default(""),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    origin: text("origin").$type<"manual" | "explicit" | "automatic">().notNull(),
    sourceEventId: text("source_event_id").references(() => homeEvents.id, {
      onDelete: "set null",
    }),
    sourceEntryId: text("source_entry_id"),
    sourceQuote: text("source_quote"),
    expiresAt: integer("expires_at"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("home_memories_owner").on(table.userId, table.agentId)],
);

export const homeMemoryRevisions = sqliteTable(
  "home_memory_revisions",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => homeMemories.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<HomeMemoryRevision>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.memoryId, table.revision] })],
);

export const homeMemoryCaptures = sqliteTable("home_memory_captures", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => homeEvents.id, { onDelete: "cascade" }),
  entryId: text("entry_id").notNull(),
  generation: integer("generation").notNull(),
  status: text("status")
    .$type<"pending" | "done" | "skipped" | "error">()
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  retryAt: integer("retry_at").notNull().default(0),
  attemptedAt: integer("attempted_at"),
});

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

export const collaborationConnections = sqliteTable(
  "collaboration_connections",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    peerAgentId: text("peer_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    direction: text("direction").$type<"incoming" | "outgoing">().notNull(),
    capabilities: text("capabilities", { mode: "json" })
      .$type<import("@carmel-agent/shared").CollaborationGrant>()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.peerAgentId, table.direction] })],
);

export const collaborations = sqliteTable("collaborations", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sourceAgentId: text("source_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  targetAgentId: text("target_agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  sourceSessionId: text("source_session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  sourceIssueId: text("source_issue_id").references(() => issues.id, { onDelete: "cascade" }),
  targetSessionId: text("target_session_id").references(() => sessions.id, {
    onDelete: "set null",
  }),
  targetIssueId: text("target_issue_id").references(() => issues.id, { onDelete: "set null" }),
  kind: text("kind").$type<"consult" | "task">().notNull(),
  status: text("status")
    .$type<"queued" | "working" | "answered" | "failed" | "cancelled">()
    .notNull(),
  request: text("request").notNull(),
  answer: text("answer"),
  sourceKey: text("source_key").notNull().unique(),
  waiting: integer("waiting", { mode: "boolean" }).notNull().default(false),
  deliveredKey: text("delivered_key"),
  createdAt: integer("created_at").notNull(),
});

export const collaborationMessages = sqliteTable("collaboration_messages", {
  id: text("id").primaryKey(),
  collaborationId: text("collaboration_id")
    .notNull()
    .references(() => collaborations.id, { onDelete: "cascade" }),
  delivered: integer("delivered", { mode: "boolean" }).notNull().default(false),
  agentId: text("agent_id").notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
});
