CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`storage_dir` text NOT NULL,
	`working_dir_mode` text DEFAULT 'default' NOT NULL,
	`working_dir` text NOT NULL,
	`default_working_dir` text NOT NULL,
	`mounts` text DEFAULT '[]' NOT NULL,
	`network` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `environments_owner_user_id` ON `environments` (`owner_user_id`);--> statement-breakpoint
INSERT INTO `environments`("id", "owner_user_id", "name", "storage_dir", "working_dir_mode", "working_dir", "default_working_dir", "mounts", "network", "created_at", "updated_at")
SELECT
	"id",
	"owner_user_id",
	"name",
	"storage_dir",
	"working_dir_mode",
	"working_dir",
	COALESCE("default_working_dir", "storage_dir" || '/workspace'),
	"mounts",
	COALESCE(json_extract("permissions", '$.network'), 0),
	"created_at",
	"updated_at"
FROM (
	SELECT *,
		CASE
			WHEN "id" GLOB '*[^A-Za-z0-9._-]*' OR "id" IN ('', '.', '..') THEN 'environments/env_' || lower(hex(randomblob(16)))
			ELSE 'agents/' || "id"
		END AS "storage_dir"
	FROM `agents`
);--> statement-breakpoint
CREATE TABLE `environment_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`session_id` text,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `environment_secrets`("id", "environment_id", "session_id", "name", "value", "created_at", "updated_at") SELECT "id", "agent_id", "session_id", "name", "value", "created_at", "updated_at" FROM `agent_secrets`;--> statement-breakpoint
DROP TABLE `agent_secrets`;--> statement-breakpoint
CREATE UNIQUE INDEX `environment_secrets_environment_name` ON `environment_secrets` (`environment_id`,`name`) WHERE "environment_secrets"."session_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `environment_secrets_session_name` ON `environment_secrets` (`session_id`,`name`) WHERE "environment_secrets"."session_id" IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`icon` text DEFAULT 'bot' NOT NULL,
	`color` text,
	`description` text NOT NULL,
	`environment_id` text NOT NULL,
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
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_model_ref_id`) REFERENCES `model_refs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agents`("id", "owner_user_id", "shared", "name", "icon", "color", "description", "environment_id", "system_prompt", "prompt_templates", "permissions", "codemode_enabled", "mcp_servers", "default_model_ref_id", "default_thinking_level", "created_at", "updated_at") SELECT "id", "owner_user_id", "shared", "name", "icon", "color", "description", "id", "system_prompt", "prompt_templates", "permissions", "codemode_enabled", "mcp_servers", "default_model_ref_id", "default_thinking_level", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agents_default_model_ref_id` ON `agents` (`default_model_ref_id`);--> statement-breakpoint
CREATE INDEX `agents_environment_id` ON `agents` (`environment_id`);--> statement-breakpoint
CREATE INDEX `agents_owner_user_id` ON `agents` (`owner_user_id`);
