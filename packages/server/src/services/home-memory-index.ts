import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { KnowledgeStatus } from "@carmel-agent/shared";
import { dataDir } from "../paths.ts";
import { stopKnowledgeWorker } from "../runtime/knowledge/worker-client.ts";
import { db } from "../db/index.ts";
import { homeMemorySettings } from "../db/schema.ts";
import { and, eq } from "drizzle-orm";
import { knowledgeLock } from "../runtime/knowledge/queue.ts";

export const emptyMemoryIndexStatus: KnowledgeStatus = {
  state: "idle",
  lastUpdatedAt: null,
  documents: 0,
  needsEmbedding: 0,
  error: null,
  backend: null,
  devices: [],
};

export function homeMemoryIndexKey(userId: string, agentId: string) {
  return `home-memory:${createHash("sha256")
    .update(JSON.stringify([userId, agentId]))
    .digest("hex")}`;
}

export function homeMemoryIndexDir(userId: string, agentId: string) {
  return resolve(dataDir, "home-memory", homeMemoryIndexKey(userId, agentId).slice(12));
}

export async function purgeHomeMemoryIndex(userId: string, agentId: string) {
  const key = homeMemoryIndexKey(userId, agentId);
  await knowledgeLock(key, async () => {
    await stopKnowledgeWorker(key);
    await rm(homeMemoryIndexDir(userId, agentId), { recursive: true, force: true });
    db.update(homeMemorySettings)
      .set({ indexStatus: null, indexDirty: true })
      .where(and(eq(homeMemorySettings.userId, userId), eq(homeMemorySettings.agentId, agentId)))
      .run();
  });
}
