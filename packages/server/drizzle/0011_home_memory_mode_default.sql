DROP TRIGGER home_memory_search_insert;--> statement-breakpoint
DROP TRIGGER home_memory_search_update;--> statement-breakpoint
DROP TRIGGER home_memory_search_delete;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_home_memory_settings` (
	`user_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`mode` text DEFAULT 'automatic' NOT NULL,
	`retrieval` text DEFAULT '{"enabled":false,"acceleration":"auto"}' NOT NULL,
	`index_status` text,
	`index_dirty` integer DEFAULT true NOT NULL,
	`forgotten` text DEFAULT '[]' NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`learn_after` integer DEFAULT 0 NOT NULL,
	`last_capture_at` integer,
	`last_capture` text,
	`calls` text DEFAULT '[]' NOT NULL,
	`error` text,
	PRIMARY KEY(`user_id`, `agent_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_home_memory_settings`("user_id", "agent_id", "mode", "retrieval", "index_status", "index_dirty", "forgotten", "generation", "learn_after", "last_capture_at", "last_capture", "calls", "error") SELECT "user_id", "agent_id", "mode", "retrieval", "index_status", "index_dirty", "forgotten", "generation", "learn_after", "last_capture_at", "last_capture", "calls", "error" FROM `home_memory_settings`;--> statement-breakpoint
DROP TABLE `home_memory_settings`;--> statement-breakpoint
ALTER TABLE `__new_home_memory_settings` RENAME TO `home_memory_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TRIGGER home_memory_search_insert AFTER INSERT ON home_memories BEGIN
  INSERT INTO home_memory_search(memory_id, content, scope, aliases, title) VALUES (NEW.id, NEW.content, NEW.scope, NEW.aliases, NEW.title);
  UPDATE home_memory_settings SET index_dirty = 1 WHERE user_id = NEW.user_id AND agent_id = NEW.agent_id;
END;
--> statement-breakpoint
CREATE TRIGGER home_memory_search_update AFTER UPDATE ON home_memories BEGIN
  DELETE FROM home_memory_search WHERE memory_id = OLD.id;
  INSERT INTO home_memory_search(memory_id, content, scope, aliases, title) VALUES (NEW.id, NEW.content, NEW.scope, NEW.aliases, NEW.title);
  UPDATE home_memory_settings SET index_dirty = 1 WHERE user_id = NEW.user_id AND agent_id = NEW.agent_id;
END;
--> statement-breakpoint
CREATE TRIGGER home_memory_search_delete AFTER DELETE ON home_memories BEGIN
  DELETE FROM home_memory_search WHERE memory_id = OLD.id;
  UPDATE home_memory_settings SET index_dirty = 1 WHERE user_id = OLD.user_id AND agent_id = OLD.agent_id;
END;
