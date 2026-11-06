import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  agents,
  homeMemories,
  homeMemoryRevisions,
  homeMemorySettings,
  knowledgeConfigs,
  knowledgeMemories,
} from "../db/schema.ts";
import { knowledgeDir } from "./knowledge.ts";
import { readHomeMemorySettings } from "./home-memory.ts";
import { emptyMemoryIndexStatus } from "./home-memory-index.ts";
import { stopKnowledgeWorker } from "../runtime/knowledge/worker-client.ts";

export async function migrateAgentMemories() {
  const configs = db.select().from(knowledgeConfigs).all();
  const legacy = db.select().from(knowledgeMemories).all();
  const ids = new Set([
    ...configs.filter((row) => !row.memoriesMigrated).map((row) => row.agentId),
    ...legacy.map((row) => row.agentId),
  ]);
  for (const agentId of ids) {
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) continue;
    const config = configs.find((row) => row.agentId === agentId);
    await stopKnowledgeWorker(agentId);
    await rm(resolve(knowledgeDir(agentId), "index"), { recursive: true, force: true });
    readHomeMemorySettings(agent.ownerUserId, agentId);
    if (config?.settings.enabled)
      db.update(homeMemorySettings)
        .set({ retrieval: config.settings })
        .where(
          and(
            eq(homeMemorySettings.userId, agent.ownerUserId),
            eq(homeMemorySettings.agentId, agentId),
          ),
        )
        .run();
    for (const row of legacy.filter((item) => item.agentId === agentId)) {
      if (row.deletedAt !== null) {
        db.delete(knowledgeMemories).where(eq(knowledgeMemories.id, row.id)).run();
        continue;
      }
      const raw =
        row.pendingContent ??
        (await readFile(resolve(knowledgeDir(agentId), "notes", `${row.id}.md`), "utf8"));
      const prefix = `# ${row.title}\n\n`;
      if (!raw.startsWith(prefix))
        throw new Error(
          `Cannot migrate memory ${row.id}: its Markdown title does not match its metadata.`,
        );
      const content = raw.slice(prefix.length);
      db.transaction(() => {
        db.insert(homeMemories)
          .values({
            id: row.id,
            userId: agent.ownerUserId,
            agentId,
            title: row.title,
            content,
            scope: row.title.slice(0, 120),
            kind: "fact",
            placement: "topic",
            origin: "manual",
            contributorId: row.contributorId,
            legacyRevision: row.revision,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })
          .onConflictDoNothing()
          .run();
        const saved = db.select().from(homeMemories).where(eq(homeMemories.id, row.id)).get();
        if (
          !saved ||
          saved.userId !== agent.ownerUserId ||
          saved.agentId !== agentId ||
          saved.title !== row.title ||
          saved.content !== content ||
          saved.legacyRevision !== row.revision ||
          saved.contributorId !== row.contributorId
        )
          throw new Error(`Cannot retire memory ${row.id}: the Home copy does not match.`);
        db.insert(homeMemoryRevisions)
          .values({
            memoryId: row.id,
            revision: 1,
            snapshot: {
              revision: 1,
              title: row.title,
              content,
              scope: row.title.slice(0, 120),
              kind: "fact",
              placement: "topic",
              aliases: [],
              expiresAt: null,
              createdAt: row.updatedAt,
            },
          })
          .onConflictDoNothing()
          .run();
        db.delete(knowledgeMemories).where(eq(knowledgeMemories.id, row.id)).run();
      });
    }
    await rm(resolve(knowledgeDir(agentId), "notes"), { recursive: true, force: true });
    if (config)
      db.update(knowledgeConfigs)
        .set({ memoriesMigrated: true, dirty: true, status: emptyMemoryIndexStatus })
        .where(eq(knowledgeConfigs.agentId, agentId))
        .run();
  }
}
