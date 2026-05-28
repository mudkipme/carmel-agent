import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { modelRefs, sessions, users } from "../db/schema.ts";
import {
  serializeModelRef,
  serializeProviderConfig,
  serializePublicAgent,
  serializeSessionMetadata,
  serializeUser,
} from "../serializers.ts";
import { readUserProviderConfigs, readVisibleAgents } from "./agent-access.ts";

export function readBootstrapPayload(userId: string) {
  const visibleProviderConfigs = readUserProviderConfigs(userId);
  const visibleProviderConfigIds = new Set(visibleProviderConfigs.map((config) => config.id));
  return {
    users: db.select().from(users).where(eq(users.id, userId)).all().map(serializeUser),
    agents: readVisibleAgents(userId).map(serializePublicAgent),
    providerConfigs: visibleProviderConfigs.map(serializeProviderConfig),
    modelRefs: db
      .select()
      .from(modelRefs)
      .all()
      .filter(
        (model) =>
          model.ownerUserId === userId ||
          model.shared ||
          !model.providerConfigId ||
          visibleProviderConfigIds.has(model.providerConfigId),
      )
      .map(serializeModelRef),
    sessions: db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .all()
      .sort(sortSessions)
      .map(serializeSessionMetadata),
  };
}

function sortSessions(a: typeof sessions.$inferSelect, b: typeof sessions.$inferSelect) {
  if (a.pinnedAt && b.pinnedAt) return b.pinnedAt - a.pinnedAt;
  if (a.pinnedAt) return -1;
  if (b.pinnedAt) return 1;
  return b.updatedAt - a.updatedAt;
}
