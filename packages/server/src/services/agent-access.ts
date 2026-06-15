import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentThinkingLevel } from "@carmel-agent/shared";
import { asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, modelRefs, providerConfigs, sessions, users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { defaultAgentWorkingDir, ensureDir, normalizeDataRelativePath, resolveDataPath } from "../paths.ts";
import { resolveServerModelRef } from "../runtime/model.ts";
import { serializeModelRef } from "../serializers.ts";

export type AgentRecord = typeof agents.$inferSelect;
export type ModelRefRecord = typeof modelRefs.$inferSelect;

// Provider configs are global infrastructure (managed by admins), so they are
// not scoped to a user.
export function readProviderConfigs() {
  return db.select().from(providerConfigs).orderBy(asc(providerConfigs.createdAt)).all();
}

export function readVisibleAgents(userId: string) {
  return db
    .select()
    .from(agents)
    .where(or(eq(agents.ownerUserId, userId), eq(agents.shared, true)))
    .all();
}

export function readVisibleAgent(userId: string, agentId: string) {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || (agent.ownerUserId !== userId && !agent.shared)) return undefined;
  return agent;
}

export function readVisibleModelRefs(userId: string) {
  return db
    .select()
    .from(modelRefs)
    .where(or(eq(modelRefs.ownerUserId, userId), eq(modelRefs.shared, true), isNull(modelRefs.providerConfigId)))
    .all();
}

export function canUseModel(userId: string, model: string | ModelRefRecord) {
  const modelRef = typeof model === "string" ? db.select().from(modelRefs).where(eq(modelRefs.id, model)).get() : model;
  if (!modelRef) return false;
  return modelRef.ownerUserId === userId || modelRef.shared || !modelRef.providerConfigId;
}

export function resolveSupportedThinkingLevel(modelRef: ModelRefRecord, thinkingLevel: AgentThinkingLevel) {
  const providerConfig = modelRef.providerConfigId
    ? db.select().from(providerConfigs).where(eq(providerConfigs.id, modelRef.providerConfigId)).get()
    : undefined;
  return clampThinkingLevel(
    resolveServerModelRef(serializeModelRef(modelRef), providerConfig),
    thinkingLevel,
  ) as AgentThinkingLevel;
}

export function resolveAgentWorkingDir(agent: AgentConfig, agentId: string, current?: AgentRecord) {
  const defaultWorkingDir = normalizeDataRelativePath(
    current?.defaultWorkingDir ?? agent.defaultWorkingDir ?? defaultAgentWorkingDir(agentId),
  );
  if ((agent.workingDirMode ?? "manual") === "default") {
    ensureDir(resolveDataPath(defaultWorkingDir));
    return {
      workingDir: defaultWorkingDir,
      defaultWorkingDir,
    };
  }

  const previousManualWorkingDir =
    current?.workingDirMode === "manual" && current.workingDir !== defaultWorkingDir ? current.workingDir : "";
  const workingDir = agent.workingDir.trim() || previousManualWorkingDir;
  if (!workingDir) return null;
  return {
    workingDir,
    defaultWorkingDir,
  };
}

export function reassignModelReferences(deletedModelIds: Set<string>) {
  const ids = [...deletedModelIds];
  if (ids.length === 0) return;
  const timestamp = now();

  db.update(users)
    .set({ fastTaskModelRefId: null, updatedAt: timestamp })
    .where(inArray(users.fastTaskModelRefId, ids))
    .run();

  const affectedAgents = db.select().from(agents).where(inArray(agents.defaultModelRefId, ids)).all();
  for (const agent of affectedAgents) {
    const fallbackModel = readFallbackModelForUser(agent.ownerUserId, deletedModelIds);
    if (!fallbackModel) continue;
    db.update(agents)
      .set({ defaultModelRefId: fallbackModel.id, updatedAt: timestamp })
      .where(eq(agents.id, agent.id))
      .run();
  }

  const affectedSessions = db.select().from(sessions).where(inArray(sessions.modelRefId, ids)).all();
  const agentIds = [...new Set(affectedSessions.map((session) => session.agentId))];
  const agentDefaultModelById = new Map(
    agentIds.length === 0
      ? []
      : db
          .select({ id: agents.id, defaultModelRefId: agents.defaultModelRefId })
          .from(agents)
          .where(inArray(agents.id, agentIds))
          .all()
          .map((agent) => [agent.id, agent.defaultModelRefId] as const),
  );

  for (const session of affectedSessions) {
    const agentDefaultModelId = agentDefaultModelById.get(session.agentId);
    const fallbackModel = readFallbackModelForUser(session.userId, deletedModelIds);
    if (!fallbackModel) continue;
    db.update(sessions)
      .set({
        modelRefId:
          agentDefaultModelId && !deletedModelIds.has(agentDefaultModelId)
            ? agentDefaultModelId
            : fallbackModel.id,
        updatedAt: timestamp,
      })
      .where(eq(sessions.id, session.id))
      .run();
  }
}

export function readAffectedModelUserIds(deletedModelIds: Set<string>) {
  const ids = [...deletedModelIds];
  if (ids.length === 0) return [];
  const userIds = new Set<string>();
  for (const agent of db.select({ ownerUserId: agents.ownerUserId }).from(agents).where(inArray(agents.defaultModelRefId, ids)).all()) {
    userIds.add(agent.ownerUserId);
  }
  for (const user of db.select({ id: users.id }).from(users).where(inArray(users.fastTaskModelRefId, ids)).all()) {
    userIds.add(user.id);
  }
  for (const session of db.select({ userId: sessions.userId }).from(sessions).where(inArray(sessions.modelRefId, ids)).all()) {
    userIds.add(session.userId);
  }
  return [...userIds];
}

export function readFallbackModelForUser(userId: string, deletedModelIds: Set<string>) {
  return readVisibleModelRefs(userId).find((model) => !deletedModelIds.has(model.id));
}
