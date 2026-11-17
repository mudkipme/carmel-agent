DROP TABLE `knowledge_memories`;--> statement-breakpoint
ALTER TABLE `home_memories` DROP COLUMN `legacy_revision`;--> statement-breakpoint
ALTER TABLE `knowledge_configs` DROP COLUMN `memories_migrated`;--> statement-breakpoint
ALTER TABLE `im_inbox` DROP COLUMN `legacy`;