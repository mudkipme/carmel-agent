-- Moving files and resolving data-relative paths needs the data directory, so
-- startup finishes this migration from `legacy_environment_workspaces` and
-- then drops it.
CREATE TABLE `legacy_environment_workspaces` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`storage_dir` text NOT NULL,
	`working_dir_mode` text NOT NULL,
	`working_dir` text NOT NULL,
	`files_agent_id` text
);
--> statement-breakpoint
INSERT INTO `legacy_environment_workspaces`("environment_id", "storage_dir", "working_dir_mode", "working_dir", "files_agent_id")
SELECT
	e."id",
	e."storage_dir",
	e."working_dir_mode",
	e."working_dir",
	(SELECT a."id" FROM `agents` a WHERE a."environment_id" = e."id" ORDER BY a."id" = e."id" DESC, a."created_at", a."id" LIMIT 1)
FROM `environments` e;--> statement-breakpoint
ALTER TABLE `agents` ADD `working_dir` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `environments` DROP COLUMN `working_dir_mode`;--> statement-breakpoint
ALTER TABLE `environments` DROP COLUMN `working_dir`;--> statement-breakpoint
ALTER TABLE `environments` DROP COLUMN `default_working_dir`;
