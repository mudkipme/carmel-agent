import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ImPlatform, ImSetup, PromptInput } from "@carmel-agent/shared";
import { agents, users } from "./schema.ts";

export const imIntegrations = sqliteTable(
  "im_integrations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").$type<ImPlatform>().notNull(),
    botId: text("bot_id").notNull(),
    botName: text("bot_name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    proactive: integer("proactive", { mode: "boolean" }).notNull().default(true),
    notificationDefault: integer("notification_default", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status").$type<"connecting" | "connected" | "disabled" | "error">().notNull(),
    error: text("error"),
    offset: integer("offset").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("im_integrations_owner_platform").on(table.agentId, table.userId, table.platform),
    uniqueIndex("im_integrations_bot").on(table.platform, table.botId),
  ],
);
export const imCredentials = sqliteTable("im_credentials", {
  integrationId: text("integration_id")
    .primaryKey()
    .references(() => imIntegrations.id, { onDelete: "cascade" }),
  value: text("value").notNull(),
});
export const imBindings = sqliteTable("im_bindings", {
  integrationId: text("integration_id")
    .primaryKey()
    .references(() => imIntegrations.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull(),
  chatId: text("chat_id").notNull(),
  sessionId: text("session_id"),
});
export const imSetups = sqliteTable(
  "im_setup_attempts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").$type<ImPlatform>().notNull(),
    status: text("status").$type<ImSetup["status"]>().notNull(),
    state: text("state").notNull(),
    botId: text("bot_id"),
    botName: text("bot_name"),
    offset: integer("offset").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    nextPollAt: integer("next_poll_at").notNull(),
    interval: integer("interval").notNull().default(5000),
    error: text("error"),
  },
  (table) => [index("im_setup_owner").on(table.agentId, table.userId)],
);
export const imInbox = sqliteTable(
  "im_inbox",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => imIntegrations.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    homeEventId: text("home_event_id"),
    legacy: integer("legacy", { mode: "boolean" }).notNull().default(false),
    prompt: text("prompt", { mode: "json" }).$type<PromptInput>().notNull(),
    imageKeys: text("image_keys", { mode: "json" }).$type<string[]>().notNull().default([]),
    messageId: text("message_id"),
    status: text("status").$type<"queued" | "running" | "done" | "interrupted">().notNull(),
    sessionId: text("session_id"),
    runId: text("run_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("im_inbox_event").on(table.integrationId, table.eventId),
    index("im_inbox_queue").on(table.status, table.createdAt),
  ],
);
export const imOutbox = sqliteTable(
  "im_outbox",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => imIntegrations.id, { onDelete: "cascade" }),
    homeEventId: text("home_event_id"),
    dedupKey: text("dedup_key").notNull().unique(),
    text: text("text").notNull(),
    proactive: integer("proactive", { mode: "boolean" }).notNull(),
    sessionId: text("session_id"),
    status: text("status").$type<import("@carmel-agent/shared").ImDelivery["status"]>().notNull(),
    providerIds: text("provider_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
    nextChunk: integer("next_chunk").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("im_outbox_pending").on(table.status, table.nextAttemptAt),
    index("im_outbox_session").on(table.sessionId),
  ],
);
