-- This initial baseline also adopts tables created before Drizzle migration tracking.
CREATE TABLE IF NOT EXISTS `agent_homes` (
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`last_read_at` integer DEFAULT 0 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `agent_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_homes_session_id_unique` ON `agent_homes` (`session_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_secrets_agent_name` ON `agent_secrets` (`agent_id`,`name`) WHERE "agent_secrets"."session_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `agent_secrets_session_name` ON `agent_secrets` (`session_id`,`name`) WHERE "agent_secrets"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text NOT NULL,
	`detail` text,
	`session_id` text,
	FOREIGN KEY (`task_id`) REFERENCES `agent_tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_task_runs_task` ON `agent_task_runs` (`task_id`,"started_at" desc);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`model_ref_id` text,
	`thinking_level` text,
	`schedule_kind` text NOT NULL,
	`schedule_value` text NOT NULL,
	`timezone` text,
	`notify_platform` text,
	`status` text DEFAULT 'active' NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_outcome` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_tasks_agent` ON `agent_tasks` (`agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_tasks_due` ON `agent_tasks` (`status`,`next_run_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`working_dir_mode` text DEFAULT 'manual' NOT NULL,
	`working_dir` text NOT NULL,
	`default_working_dir` text,
	`mounts` text DEFAULT '[]' NOT NULL,
	`system_prompt` text NOT NULL,
	`prompt_templates` text NOT NULL,
	`permissions` text NOT NULL,
	`codemode_enabled` integer DEFAULT false NOT NULL,
	`mcp_servers` text DEFAULT '[]' NOT NULL,
	`default_model_ref_id` text NOT NULL,
	`default_thinking_level` text DEFAULT 'off' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_model_ref_id`) REFERENCES `model_refs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agents_default_model_ref_id` ON `agents` (`default_model_ref_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agents_owner_user_id` ON `agents` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `api_keys_user` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `auth_sessions_token_hash_unique` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `helper_hosts` (
	`session_id` text PRIMARY KEY NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `home_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source_key` text NOT NULL,
	`kind` text DEFAULT 'input' NOT NULL,
	`origin` text NOT NULL,
	`integration_id` text,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`model_ref_id` text,
	`thinking_level` text,
	`timezone` text,
	`run_id` text,
	`reply` text,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`integration_id`) REFERENCES `im_integrations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `home_events_source_key_unique` ON `home_events` (`source_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `home_events_queue` ON `home_events` (`session_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `issue_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`session_id` text,
	`instructions` text NOT NULL,
	`brief` text NOT NULL,
	`outcome` text NOT NULL,
	`summary` text,
	`evidence` text,
	`snapshot` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `issue_attempts_issue` ON `issue_attempts` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `issue_attempts_running` ON `issue_attempts` (`issue_id`) WHERE "issue_attempts"."outcome" = 'running';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `issue_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`delivery` text,
	`entry_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `issue_notes_issue` ON `issue_notes` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`notify_platform` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`criteria` text DEFAULT '[]' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`last_run_outcome` text,
	`last_run_detail` text,
	`verdict` text,
	`verdict_summary` text,
	`queue_position` integer,
	`queued_command` text,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `issues_agent_user` ON `issues` (`agent_id`,`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `issues_queue` ON `issues` (`agent_id`,`status`,`queue_position`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `knowledge_configs` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`status` text NOT NULL,
	`dirty` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `knowledge_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`title` text NOT NULL,
	`revision` text NOT NULL,
	`contributor_id` text NOT NULL,
	`pending_content` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `knowledge_memories_agent` ON `knowledge_memories` (`agent_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `knowledge_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `knowledge_sources_agent` ON `knowledge_sources` (`agent_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `model_catalogs` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`models` text NOT NULL,
	`checked_at` integer,
	`last_modified` integer,
	`etag` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `model_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`label` text NOT NULL,
	`provider` text NOT NULL,
	`provider_config_id` text,
	`model_id` text NOT NULL,
	`api` text,
	`base_url` text,
	`context_window` integer,
	`max_tokens` integer,
	`reasoning` integer DEFAULT false NOT NULL,
	`input` text NOT NULL,
	`thinking_level_map` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `model_refs_owner_user_id` ON `model_refs` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `model_refs_provider_config_id` ON `model_refs` (`provider_config_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `model_refs_provider_config_model_unique` ON `model_refs` (`provider_config_id`,`model_id`) WHERE "model_refs"."provider_config_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `model_refs_provider_model_unique` ON `model_refs` (`provider`,`model_id`) WHERE "model_refs"."provider_config_id" IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `provider_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`provider` text NOT NULL,
	`auth_type` text DEFAULT 'api_key' NOT NULL,
	`api_key` text,
	`oauth_credential` text,
	`base_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `provider_configs_user_id` ON `provider_configs` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `provider_keys` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`api_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `provider`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session_search_state` (
	`session_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`model_ref_id` text NOT NULL,
	`thinking_level` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`forked_from` text,
	`pinned_at` integer,
	`archived_at` integer,
	`task_id` text,
	`issue_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`model_ref_id`) REFERENCES `model_refs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_agent_id` ON `sessions` (`agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_issue` ON `sessions` (`issue_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_model_ref_id` ON `sessions` (`model_ref_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_task` ON `sessions` (`task_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_user_id` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_identities` (
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer NOT NULL,
	PRIMARY KEY(`issuer`, `subject`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_identities_user` ON `user_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `user_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`call_id` text NOT NULL,
	`kind` text NOT NULL,
	`input` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`secret_id` text,
	`delivery` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_requests_call` ON `user_requests` (`session_id`,`conversation_id`,`call_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_requests_session` ON `user_requests` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text,
	`password_hash` text,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`fast_task_model_ref_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_fast_task_model_ref_id` ON `users` (`fast_task_model_ref_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`) WHERE "users"."username" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `im_bindings` (
	`integration_id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`session_id` text,
	FOREIGN KEY (`integration_id`) REFERENCES `im_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `im_credentials` (
	`integration_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `im_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `im_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`event_id` text NOT NULL,
	`home_event_id` text,
	`legacy` integer DEFAULT false NOT NULL,
	`prompt` text NOT NULL,
	`image_keys` text DEFAULT '[]' NOT NULL,
	`message_id` text,
	`status` text NOT NULL,
	`session_id` text,
	`run_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `im_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `im_inbox_event` ON `im_inbox` (`integration_id`,`event_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `im_inbox_queue` ON `im_inbox` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `im_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`bot_id` text NOT NULL,
	`bot_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`proactive` integer DEFAULT true NOT NULL,
	`notification_default` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`offset` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `im_integrations_owner_platform` ON `im_integrations` (`agent_id`,`user_id`,`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `im_integrations_bot` ON `im_integrations` (`platform`,`bot_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `im_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`home_event_id` text,
	`dedup_key` text NOT NULL,
	`text` text NOT NULL,
	`proactive` integer NOT NULL,
	`session_id` text,
	`status` text NOT NULL,
	`provider_ids` text DEFAULT '[]' NOT NULL,
	`next_chunk` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `im_integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `im_outbox_dedup_key_unique` ON `im_outbox` (`dedup_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `im_outbox_pending` ON `im_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `im_outbox_session` ON `im_outbox` (`session_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `im_setup_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`status` text NOT NULL,
	`state` text NOT NULL,
	`bot_id` text,
	`bot_name` text,
	`offset` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`next_poll_at` integer NOT NULL,
	`interval` integer DEFAULT 5000 NOT NULL,
	`error` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `im_setup_owner` ON `im_setup_attempts` (`agent_id`,`user_id`);