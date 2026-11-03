CREATE TABLE `collaboration_connections` (
	`agent_id` text NOT NULL,
	`peer_agent_id` text NOT NULL,
	`direction` text NOT NULL,
	`capabilities` text NOT NULL,
	PRIMARY KEY(`agent_id`, `peer_agent_id`, `direction`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`peer_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `collaboration_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`collaboration_id` text NOT NULL,
	`delivered` integer DEFAULT false NOT NULL,
	`agent_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`collaboration_id`) REFERENCES `collaborations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `collaborations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_agent_id` text NOT NULL,
	`target_agent_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_issue_id` text,
	`target_session_id` text,
	`target_issue_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`request` text NOT NULL,
	`answer` text,
	`source_key` text NOT NULL,
	`waiting` integer DEFAULT false NOT NULL,
	`delivered_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaborations_source_key_unique` ON `collaborations` (`source_key`);--> statement-breakpoint
ALTER TABLE `issues` ADD `collaboration_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `collaboration_id` text;