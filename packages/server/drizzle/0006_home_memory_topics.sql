ALTER TABLE `home_memories` ADD `aliases` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
DROP TRIGGER home_memory_search_insert;
--> statement-breakpoint
DROP TRIGGER home_memory_search_update;
--> statement-breakpoint
DROP TRIGGER home_memory_search_delete;
--> statement-breakpoint
DROP TABLE home_memory_search;
--> statement-breakpoint
CREATE VIRTUAL TABLE home_memory_search USING fts5(memory_id UNINDEXED, content, scope, aliases);
--> statement-breakpoint
INSERT INTO home_memory_search(memory_id, content, scope, aliases) SELECT id, content, scope, aliases FROM home_memories;
--> statement-breakpoint
CREATE TRIGGER home_memory_search_insert AFTER INSERT ON home_memories BEGIN
  INSERT INTO home_memory_search(memory_id, content, scope, aliases) VALUES (NEW.id, NEW.content, NEW.scope, NEW.aliases);
END;
--> statement-breakpoint
CREATE TRIGGER home_memory_search_update AFTER UPDATE ON home_memories BEGIN
  DELETE FROM home_memory_search WHERE memory_id = OLD.id;
  INSERT INTO home_memory_search(memory_id, content, scope, aliases) VALUES (NEW.id, NEW.content, NEW.scope, NEW.aliases);
END;
--> statement-breakpoint
CREATE TRIGGER home_memory_search_delete AFTER DELETE ON home_memories BEGIN
  DELETE FROM home_memory_search WHERE memory_id = OLD.id;
END;
