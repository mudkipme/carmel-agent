ALTER TABLE `home_memories` ADD `title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `home_memories` ADD `contributor_id` text;--> statement-breakpoint
ALTER TABLE `home_memories` ADD `legacy_revision` text;--> statement-breakpoint
ALTER TABLE `home_memory_settings` ADD `retrieval` text DEFAULT '{"enabled":false,"acceleration":"auto"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `home_memory_settings` ADD `index_status` text;--> statement-breakpoint
ALTER TABLE `home_memory_settings` ADD `index_dirty` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_configs` ADD `memories_migrated` integer DEFAULT false NOT NULL;
--> statement-breakpoint
DROP TRIGGER home_memory_search_insert;
--> statement-breakpoint
DROP TRIGGER home_memory_search_update;
--> statement-breakpoint
DROP TRIGGER home_memory_search_delete;
--> statement-breakpoint
DROP TABLE home_memory_search;
--> statement-breakpoint
CREATE VIRTUAL TABLE home_memory_search USING fts5(memory_id UNINDEXED, content, scope, aliases, title);
--> statement-breakpoint
INSERT INTO home_memory_search(memory_id, content, scope, aliases, title) SELECT id, content, scope, aliases, title FROM home_memories;
--> statement-breakpoint
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
