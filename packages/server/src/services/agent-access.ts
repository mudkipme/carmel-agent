import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentThinkingLevel } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, modelRefs, providerConfigs, sessions, users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { defaultAgentWorkingDir, ensureDir, normalizeDataRelativePath, resolveDataPath } from "../paths.ts";
import { resolveServerModelRef } from "../runtime/model.ts";
import { serializeModelRef } from "../serializers.ts";

export type AgentRecord = typeof agents.$inferSelect;
export type ModelRefRecord = typeof modelRefs.$inferSelect;

export function readUserProviderConfigs(userId: string) {
  return db.select().from(providerConfigs).where(eq(providerConfigs.userId, userId)).all();
}

export function readVisibleAgents(userId: string) {
  return db
    .select()
    .from(agents)
    .all()
    .filter((agent) => agent.ownerUserId === userId || agent.shared);
}

export function readVisibleAgent(userId: string, agentId: string) {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || (agent.ownerUserId !== userId && !agent.shared)) return undefined;
  return agent;
}

export function readVisibleModelRefs(userId: string) {
  const providerConfigIds = new Set(readUserProviderConfigs(userId).map((config) => config.id));
  return db
    .select()
    .from(modelRefs)
    .all()
    .filter(
      (model) =>
        model.ownerUserId === userId ||
        model.shared ||
        !model.providerConfigId ||
        providerConfigIds.has(model.providerConfigId),
    );
}

export function ownsProviderConfig(userId: string, providerConfigId: string) {
  return Boolean(
    db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, providerConfigId))
      .get()?.userId === userId,
  );
}

export function canUseModel(userId: string, model: string | ModelRefRecord) {
  const modelRef = typeof model === "string" ? db.select().from(modelRefs).where(eq(modelRefs.id, model)).get() : model;
  if (!modelRef) return false;
  return (
    modelRef.ownerUserId === userId ||
    modelRef.shared ||
    !modelRef.providerConfigId ||
    ownsProviderConfig(userId, modelRef.providerConfigId)
  );
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
  const timestamp = now();
  const affectedUsers = db
    .select()
    .from(users)
    .all()
    .filter((user) => user.fastTaskModelRefId && deletedModelIds.has(user.fastTaskModelRefId));

  for (const user of affectedUsers) {
    db.update(users)
      .set({ fastTaskModelRefId: null, updatedAt: timestamp })
      .where(eq(users.id, user.id))
      .run();
  }

  const affectedAgents = db
    .select()
    .from(agents)
    .all()
    .filter((agent) => deletedModelIds.has(agent.defaultModelRefId));

  for (const agent of affectedAgents) {
    const fallbackModel = readFallbackModelForUser(agent.ownerUserId, deletedModelIds);
    if (!fallbackModel) continue;
    db.update(agents)
      .set({ defaultModelRefId: fallbackModel.id, updatedAt: timestamp })
      .where(eq(agents.id, agent.id))
      .run();
  }

  const currentAgents = new Map(db.select().from(agents).all().map((agent) => [agent.id, agent]));
  const affectedSessions = db
    .select()
    .from(sessions)
    .all()
    .filter((session) => deletedModelIds.has(session.modelRefId));

  for (const session of affectedSessions) {
    const agentDefaultModelId = currentAgents.get(session.agentId)?.defaultModelRefId;
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
  const userIds = new Set<string>();
  for (const agent of db.select().from(agents).all()) {
    if (deletedModelIds.has(agent.defaultModelRefId)) userIds.add(agent.ownerUserId);
  }
  for (const user of db.select().from(users).all()) {
    if (user.fastTaskModelRefId && deletedModelIds.has(user.fastTaskModelRefId)) userIds.add(user.id);
  }
  for (const session of db.select().from(sessions).all()) {
    if (deletedModelIds.has(session.modelRefId)) userIds.add(session.userId);
  }
  return [...userIds];
}

export function readFallbackModelForUser(userId: string, deletedModelIds: Set<string>) {
  return readVisibleModelRefs(userId).find((model) => !deletedModelIds.has(model.id));
}
