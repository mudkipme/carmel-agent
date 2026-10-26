CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(session_id UNINDEXED, entry_id UNINDEXED, text);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS session_search_delete AFTER DELETE ON sessions BEGIN
  DELETE FROM session_search WHERE session_id = OLD.id;
END;
