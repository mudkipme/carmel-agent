CREATE TABLE `home_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`content` text NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`slot` text DEFAULT '' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`origin` text NOT NULL,
	`source_event_id` text,
	`source_entry_id` text,
	`source_quote` text,
	`expires_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_event_id`) REFERENCES `home_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `home_memories_owner` ON `home_memories` (`user_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `home_memory_captures` (
	`entry_id` text NOT NULL,
	`event_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`attempted_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `home_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `home_memory_revisions` (
	`memory_id` text NOT NULL,
	`revision` integer NOT NULL,
	`snapshot` text NOT NULL,
	PRIMARY KEY(`memory_id`, `revision`),
	FOREIGN KEY (`memory_id`) REFERENCES `home_memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `home_memory_settings` (
	`calls` text DEFAULT '[]' NOT NULL,
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`mode` text DEFAULT 'manual' NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`learn_after` integer DEFAULT 0 NOT NULL,
	`last_capture_at` integer,
	`error` text,
	PRIMARY KEY(`user_id`, `agent_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE VIRTUAL TABLE home_memory_search USING fts5(memory_id UNINDEXED, content, scope);
--> statement-breakpoint
CREATE TRIGGER home_memory_search_insert AFTER INSERT ON home_memories BEGIN
  INSERT INTO home_memory_search(memory_id, content, scope) VALUES (NEW.id, NEW.content, NEW.scope);
END;
--> statement-breakpoint
CREATE TRIGGER home_memory_search_update AFTER UPDATE ON home_memories BEGIN
  DELETE FROM home_memory_search WHERE memory_id = OLD.id;
  INSERT INTO home_memory_search(memory_id, content, scope) VALUES (NEW.id, NEW.content, NEW.scope);
END;
--> statement-breakpoint
CREATE TRIGGER home_memory_search_delete AFTER DELETE ON home_memories BEGIN
  DELETE FROM home_memory_search WHERE memory_id = OLD.id;
END;
