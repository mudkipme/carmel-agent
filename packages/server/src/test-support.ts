import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentMount } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { agents, environments, modelRefs, providerConfigs, sessions, users } from "./db/schema.ts";
import { id, now } from "./db/seed.ts";
import { agentFolderName } from "./paths.ts";

// Insert helpers for DB-backed tests. The test runner points DATABASE_URL at an
// in-memory database, so these never touch real data.

export function createUser() {
  const userId = id("user");
  const timestamp = now();
  db.insert(users)
    .values({
      id: userId,
      name: "Test",
      email: `${userId}@test.local`,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return userId;
}

export function createProviderConfig(userId: string) {
  const configId = id("provider_config");
  const timestamp = now();
  db.insert(providerConfigs)
    .values({
      id: configId,
      userId,
      label: "Test",
      provider: "openai",
      authType: "api_key",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return configId;
}

export function createModelRef(options: {
  ownerUserId: string;
  shared?: boolean;
  providerConfigId?: string;
}) {
  const modelRefId = id("model_ref");
  const timestamp = now();
  db.insert(modelRefs)
    .values({
      id: modelRefId,
      ownerUserId: options.ownerUserId,
      shared: options.shared ?? false,
      label: "Test",
      provider: "openai",
      modelId: modelRefId, // unique to satisfy the (provider, model_id) uniqueness index
      input: ["text"],
      reasoning: false,
      providerConfigId: options.providerConfigId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return modelRefId;
}

type EnvironmentRecord = typeof environments.$inferSelect;

/**
 * An environment row, unsaved. Pass to `insertEnvironment` when the database
 * must see it. `workingDir` mounts that host folder at the same runner path, so
 * an agent with the same `workingDir` works directly in it.
 */
export function makeEnvironment(
  options: Partial<EnvironmentRecord> & { workingDir?: string } = {},
): EnvironmentRecord {
  const { workingDir, ...environment } = options;
  const environmentId = environment.id ?? id("env");
  return {
    id: environmentId,
    ownerUserId: "user_self",
    name: "Test",
    storageDir: `environments/${environmentId}`,
    network: false,
    createdAt: 0,
    updatedAt: 0,
    ...environment,
    mounts: [...(workingDir ? [{ source: workingDir }] : []), ...(environment.mounts ?? [])],
  };
}

/**
 * A saved environment and a host folder for `agentId` to work in. By default
 * the folder is mounted at the same runner path and the agent's `workingDir`
 * names it; with `defaultFolder` it is the agent's own folder under /workspace.
 */
export function insertWorkspaceEnvironment(
  agentId: string,
  options: {
    ownerUserId: string;
    workingDir?: string;
    defaultFolder?: boolean;
    mounts?: AgentMount[];
  },
) {
  if (options.defaultFolder) {
    const storageDir = mkdtempSync(join(tmpdir(), "carmel-environment-"));
    const workingDir = join(storageDir, "workspace", agentFolderName(agentId));
    mkdirSync(workingDir, { recursive: true });
    const environment = insertEnvironment(
      makeEnvironment({ ownerUserId: options.ownerUserId, storageDir, mounts: options.mounts }),
    );
    return { environment, workingDir, agentWorkingDir: "" };
  }
  const workingDir = options.workingDir ?? mkdtempSync(join(tmpdir(), "carmel-workspace-"));
  const environment = insertEnvironment(
    makeEnvironment({ ownerUserId: options.ownerUserId, workingDir, mounts: options.mounts }),
  );
  return { environment, workingDir, agentWorkingDir: workingDir };
}

export function insertEnvironment(environment: EnvironmentRecord) {
  db.insert(environments).values(environment).run();
  return environment;
}

export function createEnvironment(
  ownerUserId: string,
  options: Partial<EnvironmentRecord> & { workingDir?: string } = {},
) {
  return insertEnvironment(makeEnvironment({ ...options, ownerUserId })).id;
}

export function createAgent(options: {
  ownerUserId: string;
  shared?: boolean;
  defaultModelRefId: string;
  environmentId?: string;
  workingDir?: string;
}) {
  const agentId = id("agent");
  const timestamp = now();
  db.insert(agents)
    .values({
      id: agentId,
      ownerUserId: options.ownerUserId,
      shared: options.shared ?? false,
      name: "Test",
      description: "",
      environmentId:
        options.environmentId ??
        createEnvironment(options.ownerUserId, { workingDir: options.workingDir }),
      workingDir: options.workingDir ?? "",
      systemPrompt: "",
      promptTemplates: [],
      permissions: { read: true, write: false, edit: false, bash: false, network: false },
      defaultModelRefId: options.defaultModelRefId,
      defaultThinkingLevel: "off",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return agentId;
}

export function createSession(options?: { userId?: string }) {
  const userId = options?.userId ?? createUser();
  const modelRefId = createModelRef({ ownerUserId: userId });
  const agentId = createAgent({ ownerUserId: userId, defaultModelRefId: modelRefId });
  const sessionId = id("session");
  const timestamp = now();
  db.insert(sessions)
    .values({
      id: sessionId,
      title: "Test",
      userId,
      agentId,
      modelRefId,
      thinkingLevel: "off",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return { sessionId, userId, agentId, modelRefId };
}

export function userMessage(content: string): AgentMessage {
  return { role: "user", content } as unknown as AgentMessage;
}

export function agentEnvironmentId(agentId: string) {
  return db.select().from(agents).where(eq(agents.id, agentId)).get()!.environmentId;
}

/** Mount a host folder into the agent's environment and have the agent work in it. */
export function setAgentWorkingDir(agentId: string, workingDir: string) {
  const environmentId = agentEnvironmentId(agentId);
  const { mounts } = db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .get()!;
  if (!mounts.some((mount) => mount.source === workingDir))
    db.update(environments)
      .set({ mounts: [...mounts, { source: workingDir }] })
      .where(eq(environments.id, environmentId))
      .run();
  db.update(agents).set({ workingDir }).where(eq(agents.id, agentId)).run();
}
