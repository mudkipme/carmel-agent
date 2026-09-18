import { and, eq, isNull } from "drizzle-orm";
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

export function readBootstrapPayload(userId: string) {
  return {
    users: db.select().from(users).where(eq(users.id, userId)).all().map(serializeUser),
    agents: readVisibleAgents(userId).map(serializePublicAgent),
    providerConfigs: readProviderConfigs().map(serializeProviderConfig),
    modelRefs: readVisibleModelRefs(userId).map(serializeModelRef),
    modelCatalog: readModelCatalog(),
    sessions: readSessionMetadataForUser(userId),
  };
}

// Session rows only: bootstrap never needs a transcript, so it must not open a
// Pi session per row to read one. Archived sessions, task runs, and issues stay
// out of the session list; each is listed where it belongs.
function readSessionMetadataForUser(userId: string) {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.archivedAt), isNull(sessions.taskId), isNull(sessions.issueId)))
    .all()
    .sort(sortSessions)
    .map(serializeSessionMetadata);
}

function sortSessions(a: typeof sessions.$inferSelect, b: typeof sessions.$inferSelect) {
  if (a.pinnedAt && b.pinnedAt) return b.pinnedAt - a.pinnedAt;
  if (a.pinnedAt) return -1;
  if (b.pinnedAt) return 1;
  return b.updatedAt - a.updatedAt;
}
