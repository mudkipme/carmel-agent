import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions, users } from "../db/schema.ts";
import {
  serializeModelRef,
  serializeProviderConfig,
  serializePublicAgent,
  serializeSessionMetadata,
  serializeUser,
} from "../serializers.ts";
import { readProviderConfigs, readVisibleAgents, readVisibleModelRefs } from "./agent-access.ts";
import { readModelCatalog } from "./model-catalog.ts";
import { readSessionMessageCountsForUser } from "./session-store.ts";

export async function readBootstrapPayload(userId: string) {
  return {
    users: db.select().from(users).where(eq(users.id, userId)).all().map(serializeUser),
    agents: readVisibleAgents(userId).map(serializePublicAgent),
    providerConfigs: readProviderConfigs().map(serializeProviderConfig),
    modelRefs: readVisibleModelRefs(userId).map(serializeModelRef),
    modelCatalog: readModelCatalog(),
    sessions: await readSessionMetadataForUser(userId),
  };
}

async function readSessionMetadataForUser(userId: string) {
  const counts = await readSessionMessageCountsForUser(userId);
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .all()
    .sort(sortSessions)
    .map((session) => serializeSessionMetadata(session, counts.get(session.id) ?? 0));
}

function sortSessions(a: typeof sessions.$inferSelect, b: typeof sessions.$inferSelect) {
  if (a.pinnedAt && b.pinnedAt) return b.pinnedAt - a.pinnedAt;
  if (a.pinnedAt) return -1;
  if (b.pinnedAt) return 1;
  return b.updatedAt - a.updatedAt;
}
