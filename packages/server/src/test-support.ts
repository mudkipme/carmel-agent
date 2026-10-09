import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { db } from "./db/index.ts";
import { agents, modelRefs, providerConfigs, sessions, users } from "./db/schema.ts";
import { id, now } from "./db/seed.ts";

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

export function createAgent(options: {
  ownerUserId: string;
  shared?: boolean;
  defaultModelRefId: string;
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
      workingDirMode: "manual",
      workingDir: "/tmp/test",
      mounts: [],
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
