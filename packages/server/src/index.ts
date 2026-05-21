import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { createAuthSession, clearAuthSession, hashPassword, requireAuth, verifyPassword, type AuthVariables } from "./auth.ts";
import { abortAgentRun, createAgentRunResponse, normalizePromptInput } from "./runtime/agent-runtime.ts";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { createProviderConfigAuthStorage } from "./runtime/auth-storage.ts";
import { resolveClientToolResult } from "./runtime/client-tools.ts";
import { resolveServerModelRef } from "./runtime/model.ts";
import {
  listOAuthProviders,
  readOAuthLoginFlow,
  startOAuthLoginFlow,
  submitOAuthLoginFlowInput,
} from "./runtime/oauth-flows.ts";
import { createAgentResourceLoader, listAvailableGlobalSkills } from "./runtime/resources.ts";
import { createAgentFilesRoute } from "./routes/agent-files.ts";
import { db, migrate, seed } from "./db/index.ts";
import { agents, modelRefs, providerConfigs, providerKeys, sessions, users } from "./db/schema.ts";
import { id, now } from "./db/seed.ts";
import { defaultAgentWorkingDir, ensureDir, normalizeDataRelativePath, resolveDataPath } from "./paths.ts";
import {
  serializeAgentSettings,
  serializeModelRef,
  serializeProviderConfig,
  serializePublicAgent,
  serializeSession,
  serializeSessionMetadata,
  serializeUser,
} from "./serializers.ts";
import {
  agentConfigRequestSchema,
  agentRunRequestSchema,
  clientToolResultRequestSchema,
  forkSessionRequestSchema,
  isValidationError,
  jsonValidator,
  loginRequestSchema,
  modelRefRequestSchema,
  oauthInputRequestSchema,
  passwordRequestSchema,
  providerConfigRequestSchema,
  sessionDraftRequestSchema,
  sessionPatchRequestSchema,
  userRequestSchema,
  validationErrorMessage,
} from "./validation.ts";
import type {
  AgentConfig,
  AgentThinkingLevel,
  ClientToolResultPayload,
  ModelRef,
  PromptInput,
  ProviderConfig,
  ProviderModelSummary,
  Session,
  User,
} from "@carmel-agent/shared";
import { DEFAULT_OLLAMA_BASE_URL, OLLAMA_PROVIDER } from "@carmel-agent/shared";

migrate();
seed();

const app = new Hono<{ Variables: AuthVariables }>();

app.onError((error, c) => {
  if (isValidationError(error)) return c.json({ error: validationErrorMessage(error) }, 400);
  console.error(error);
  return c.json({ error: "Internal server error." }, 500);
});

app.use("*", compress({ encoding: "gzip", threshold: 1024 }));
app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);
app.use("/api/*", requireAuth);

app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/auth/login", jsonValidator(loginRequestSchema), async (c) => {
  const body = c.req.valid("json");
  const username = body.username?.trim();
  if (!username || !body.password) return c.json({ error: "Username and password are required." }, 400);

  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
    return c.json({ error: "Invalid username or password." }, 401);
  }

  await createAuthSession(c, user.id);
  return c.json(readBootstrapPayload(user.id));
});

app.post("/api/auth/logout", (c) => {
  clearAuthSession(c);
  return c.json({ ok: true });
});

app.post("/api/auth/password", jsonValidator(passwordRequestSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  if (!body.currentPassword || !body.newPassword) {
    return c.json({ error: "Current and new password are required." }, 400);
  }
  if (body.newPassword.length < 8) return c.json({ error: "New password must be at least 8 characters." }, 400);
  if (!user.passwordHash || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
    return c.json({ error: "Current password is incorrect." }, 400);
  }
  db.update(users)
    .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: now() })
    .where(eq(users.id, user.id))
    .run();
  return c.json({ ok: true });
});

app.get("/api/bootstrap", (c) => {
  return c.json(readBootstrapPayload(c.get("user").id));
});

app.get("/api/skills/global", (c) => {
  return c.json(
    listAvailableGlobalSkills().map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
    })),
  );
});

app.post("/api/client-tool-results", jsonValidator(clientToolResultRequestSchema), async (c) => {
  const user = c.get("user");
  try {
    resolveClientToolResult(user.id, c.req.valid("json") as ClientToolResultPayload);
    return c.json({ ok: true });
  } catch (error) {
    if (isValidationError(error)) return c.json({ error: validationErrorMessage(error) }, 400);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.put("/api/users/:id", jsonValidator(userRequestSchema), async (c) => {
  const currentUser = c.get("user");
  if (c.req.param("id") !== currentUser.id) return c.json({ error: "You can only update your own profile." }, 403);
  const user = c.req.valid("json") as User;
  const fastTaskModelRefId = user.fastTaskModelRefId?.trim() || null;
  if (fastTaskModelRefId && !canUseModel(currentUser.id, fastTaskModelRefId)) {
    return c.json({ error: "Fast task model not found." }, 404);
  }
  const timestamp = now();
  db.insert(users)
    .values({
      id: currentUser.id,
      username: currentUser.username,
      passwordHash: currentUser.passwordHash,
      name: user.name,
      email: user.email,
      fastTaskModelRefId,
      createdAt: currentUser.createdAt,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { name: user.name, email: user.email, fastTaskModelRefId, updatedAt: timestamp },
    })
    .run();
  return c.json(serializeUser(db.select().from(users).where(eq(users.id, currentUser.id)).get()!));
});

app.put("/api/models/:id", jsonValidator(modelRefRequestSchema), async (c) => {
  const currentUserId = c.get("user").id;
  const model = c.req.valid("json") as ModelRef;
  const current = db.select().from(modelRefs).where(eq(modelRefs.id, c.req.param("id"))).get();
  if (current && current.ownerUserId !== currentUserId) return c.json({ error: "Model not found." }, 404);
  if (model.providerConfigId && !ownsProviderConfig(currentUserId, model.providerConfigId)) {
    return c.json({ error: "Provider config not found." }, 404);
  }
  const timestamp = now();
  const duplicate = db
    .select()
    .from(modelRefs)
    .all()
    .find(
      (item) =>
        item.id !== c.req.param("id") &&
        item.modelId === model.modelId &&
        (model.providerConfigId
          ? item.providerConfigId === model.providerConfigId
          : item.provider === model.provider && !item.providerConfigId),
    );
  if (duplicate) return c.json(serializeModelRef(duplicate));

  db.insert(modelRefs)
    .values({
      ...model,
      id: c.req.param("id"),
      ownerUserId: currentUserId,
      shared: model.shared ?? false,
      input: model.input ?? ["text"],
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: modelRefs.id,
      set: {
        label: model.label,
        ownerUserId: currentUserId,
        shared: model.shared ?? false,
        provider: model.provider,
        providerConfigId: model.providerConfigId,
        modelId: model.modelId,
        api: model.api,
        baseUrl: model.baseUrl,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning ?? false,
        input: model.input ?? ["text"],
        customHeaders: model.customHeaders,
        updatedAt: timestamp,
      },
    })
    .run();
  return c.json(serializeModelRef(db.select().from(modelRefs).where(eq(modelRefs.id, c.req.param("id"))).get()!));
});

app.delete("/api/models/:id", (c) => {
  const currentUserId = c.get("user").id;
  const modelId = c.req.param("id");
  const model = db.select().from(modelRefs).where(eq(modelRefs.id, modelId)).get();
  if (!model || model.ownerUserId !== currentUserId) return c.json({ error: "Model not found." }, 404);
  const deletedModelIds = new Set([modelId]);
  const missingFallbackUserIds = readAffectedModelUserIds(deletedModelIds).filter(
    (userId) => !readFallbackModelForUser(userId, deletedModelIds),
  );
  if (missingFallbackUserIds.length > 0) {
    return c.json({ error: "Every affected user needs another visible model before deleting this model." }, 409);
  }
  reassignModelReferences(deletedModelIds);
  db.delete(modelRefs).where(eq(modelRefs.id, modelId)).run();
  return c.json(readBootstrapPayload(currentUserId));
});

app.put("/api/provider-configs/:id", jsonValidator(providerConfigRequestSchema), async (c) => {
  const currentUserId = c.get("user").id;
  const providerConfig = c.req.valid("json") as ProviderConfig;
  const timestamp = now();
  const current = db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get();
  if (current && current.userId !== currentUserId) return c.json({ error: "Provider config not found." }, 404);
  const authType = providerConfig.authType ?? current?.authType ?? "api_key";
  const apiKey = authType === "api_key" ? (providerConfig.apiKey ?? current?.apiKey ?? null) : null;
  const oauthCredential = authType === "oauth" ? (current?.oauthCredential ?? null) : null;
  db.insert(providerConfigs)
    .values({
      ...providerConfig,
      id: c.req.param("id"),
      userId: currentUserId,
      authType,
      apiKey,
      oauthCredential,
      createdAt: providerConfig.createdAt ?? timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: providerConfigs.id,
      set: {
        userId: currentUserId,
        label: providerConfig.label,
        provider: providerConfig.provider,
        authType,
        apiKey,
        oauthCredential,
        baseUrl: providerConfig.baseUrl,
        customHeaders: providerConfig.customHeaders,
        updatedAt: timestamp,
      },
    })
    .run();
  return c.json(
    serializeProviderConfig(db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get()!),
  );
});

app.get("/api/provider-configs/:id/models", async (c) => {
  const currentUserId = c.get("user").id;
  const providerConfig = db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get();
  if (!providerConfig || providerConfig.userId !== currentUserId) {
    return c.json({ error: "Provider config not found." }, 404);
  }
  if (providerConfig.provider !== OLLAMA_PROVIDER) return c.json([] satisfies ProviderModelSummary[]);

  try {
    return c.json(await listOllamaModels(providerConfig.baseUrl ?? DEFAULT_OLLAMA_BASE_URL));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to discover provider models." }, 502);
  }
});

app.get("/api/oauth/providers", (c) => {
  return c.json(listOAuthProviders());
});

app.post("/api/provider-configs/:id/oauth/login", async (c) => {
  const currentUserId = c.get("user").id;
  const providerConfig = db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get();
  if (!providerConfig || providerConfig.userId !== currentUserId) {
    return c.json({ error: "Provider config not found." }, 404);
  }
  try {
    return c.json(await startOAuthLoginFlow(currentUserId, providerConfig));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.get("/api/oauth/flows/:id", (c) => {
  const flow = readOAuthLoginFlow(c.get("user").id, c.req.param("id"));
  if (!flow) return c.json({ error: "OAuth flow not found." }, 404);
  return c.json(flow);
});

app.post("/api/oauth/flows/:id/input", jsonValidator(oauthInputRequestSchema), async (c) => {
  const body = c.req.valid("json");
  try {
    const flow = submitOAuthLoginFlowInput(c.get("user").id, c.req.param("id"), body.value ?? "");
    if (!flow) return c.json({ error: "OAuth flow not found." }, 404);
    return c.json(flow);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.delete("/api/provider-configs/:id", (c) => {
  const currentUserId = c.get("user").id;
  const providerConfigId = c.req.param("id");
  if (!ownsProviderConfig(currentUserId, providerConfigId)) return c.json({ error: "Provider config not found." }, 404);
  const relatedModels = db.select().from(modelRefs).where(eq(modelRefs.providerConfigId, providerConfigId)).all();
  const deletedModelIds = new Set(relatedModels.map((model) => model.id));
  if (deletedModelIds.size > 0) {
    const missingFallbackUserIds = readAffectedModelUserIds(deletedModelIds).filter(
      (userId) => !readFallbackModelForUser(userId, deletedModelIds),
    );
    if (missingFallbackUserIds.length > 0) {
      return c.json({ error: "Every affected user needs another visible model before deleting this provider." }, 409);
    }
    reassignModelReferences(deletedModelIds);
  }

  db.delete(modelRefs).where(eq(modelRefs.providerConfigId, providerConfigId)).run();
  db.delete(providerConfigs).where(eq(providerConfigs.id, providerConfigId)).run();
  return c.json(readBootstrapPayload(currentUserId));
});

app.put("/api/agents/:id", jsonValidator(agentConfigRequestSchema), async (c) => {
  const currentUserId = c.get("user").id;
  const agent = c.req.valid("json") as AgentConfig;
  const agentId = c.req.param("id");
  const current = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (current && current.ownerUserId !== currentUserId) return c.json({ error: "Agent not found." }, 404);
  const defaultModelRef = db.select().from(modelRefs).where(eq(modelRefs.id, agent.defaultModelRefId)).get();
  if (!defaultModelRef || !canUseModel(currentUserId, defaultModelRef)) return c.json({ error: "Model not found." }, 404);
  const defaultThinkingLevel = resolveSupportedThinkingLevel(defaultModelRef, agent.defaultThinkingLevel ?? "off");
  const workingDir = resolveAgentWorkingDir(agent, agentId, current);
  if (!workingDir) return c.json({ error: "Manual working directory is required." }, 400);
  const timestamp = now();
  db.insert(agents)
    .values({
      ...agent,
      id: agentId,
      ownerUserId: currentUserId,
      workingDirMode: agent.workingDirMode ?? "manual",
      workingDir: workingDir.workingDir,
      defaultWorkingDir: workingDir.defaultWorkingDir,
      defaultThinkingLevel,
      createdAt: agent.createdAt ?? timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        ownerUserId: currentUserId,
        shared: agent.shared,
        name: agent.name,
        description: agent.description,
        workingDirMode: agent.workingDirMode ?? "manual",
        workingDir: workingDir.workingDir,
        defaultWorkingDir: workingDir.defaultWorkingDir,
        skills: agent.skills,
        systemPrompt: agent.systemPrompt,
        promptTemplates: agent.promptTemplates,
        permissions: agent.permissions,
        defaultModelRefId: agent.defaultModelRefId,
        defaultThinkingLevel,
        updatedAt: timestamp,
      },
    })
    .run();
  return c.json(serializePublicAgent(db.select().from(agents).where(eq(agents.id, agentId)).get()!));
});

app.delete("/api/agents/:id", (c) => {
  const currentUserId = c.get("user").id;
  const agentId = c.req.param("id");
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || agent.ownerUserId !== currentUserId) return c.json({ error: "Agent not found." }, 404);
  db.delete(sessions).where(eq(sessions.agentId, agentId)).run();
  db.delete(agents).where(eq(agents.id, agentId)).run();
  return c.json({ ok: true });
});

app.get("/api/agents/:id/settings", (c) => {
  const agent = db.select().from(agents).where(eq(agents.id, c.req.param("id"))).get();
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  if (agent.ownerUserId !== c.get("user").id) return c.json({ error: "Agent settings are owner-only." }, 403);
  return c.json(serializeAgentSettings(agent));
});

app.get("/api/agents/:id/commands", async (c) => {
  const userId = c.get("user").id;
  const agent = readVisibleAgent(userId, c.req.param("id"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  const resourceLoader = await createAgentResourceLoader(agent);
  const { skills } = resourceLoader.getSkills();
  const { prompts } = resourceLoader.getPrompts();
  const promptCommands = prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    source: "prompt" as const,
    commandText: `/${prompt.name} `,
    sourcePath: prompt.filePath,
    argumentHint: prompt.argumentHint,
  }));
  const skillCommands = skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill" as const,
    commandText: `/skill:${skill.name} `,
    sourcePath: skill.filePath,
  }));
  const agentTemplateCommands = agent.promptTemplates.map((template) => ({
    name: template.name,
    description: template.body,
    source: "prompt" as const,
    commandText: template.body,
  }));
  return c.json({
    commands: [...promptCommands, ...agentTemplateCommands, ...skillCommands].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  });
});

app.route("/api/agents", createAgentFilesRoute(readVisibleAgent));

app.post("/api/agent-runs/:runId/abort", (c) => {
  const aborted = abortAgentRun(c.get("user").id, c.req.param("runId"));
  if (!aborted) return c.json({ error: "Agent run not found" }, 404);
  return c.json({ ok: true });
});

app.post("/api/agents/:id/run", jsonValidator(agentRunRequestSchema), async (c) => {
  const currentUserId = c.get("user").id;
  const agent = readVisibleAgent(currentUserId, c.req.param("id"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const body = c.req.valid("json");
  const session = body.sessionId
    ? db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get()
    : undefined;
  if (!session || session.userId !== currentUserId || session.agentId !== agent.id) {
    return c.json({ error: "Session not found" }, 404);
  }

  const modelRef = db
    .select()
    .from(modelRefs)
    .where(eq(modelRefs.id, body.modelRefId ?? session.modelRefId))
    .get();
  if (!modelRef) return c.json({ error: "Model not found" }, 404);
  if (!canUseModel(currentUserId, modelRef)) return c.json({ error: "Model not found" }, 404);

  const providerConfig = modelRef.providerConfigId
    ? db.select().from(providerConfigs).where(eq(providerConfigs.id, modelRef.providerConfigId)).get()
    : undefined;
  const providerKey = db
    .select()
    .from(providerKeys)
    .where(eq(providerKeys.userId, session.userId))
    .all()
    .find((item) => item.provider === modelRef.provider);
  const authStorage = providerConfig ? createProviderConfigAuthStorage(providerConfig, modelRef.provider) : AuthStorage.inMemory();
  if (!providerConfig && providerKey?.apiKey) authStorage.setRuntimeApiKey(modelRef.provider, providerKey.apiKey);
  ensureOptionalProviderAuth(authStorage, modelRef.provider);
  if (!hasProviderAuth(authStorage, modelRef.provider)) {
    return c.json({ error: "No API key or OAuth login configured for this model provider." }, 400);
  }

  let promptInput: PromptInput | undefined;
  try {
    promptInput = normalizePromptInput(body.promptInput);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  return createAgentRunResponse({
    agent,
    session,
    modelRef,
    providerConfig,
    authStorage,
    thinkingLevel: body.thinkingLevel ?? session.thinkingLevel,
    promptInput,
  });
});

app.get("/api/sessions/:id", (c) => {
  const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
  if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
  return c.json(serializeSession(session));
});

app.post("/api/sessions", jsonValidator(sessionDraftRequestSchema), async (c) => {
  const currentUserId = c.get("user").id;
  const draft = c.req.valid("json");
  const agent = readVisibleAgent(currentUserId, draft.agentId);
  if (!agent) return c.json({ error: "Agent not found." }, 404);
  const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, draft.modelRefId)).get();
  if (!modelRef || !canUseModel(currentUserId, modelRef)) return c.json({ error: "Model not found." }, 404);
  const timestamp = now();
  const session: Session = {
    id: id("session"),
    title: draft.title ?? "Untitled session",
    userId: currentUserId,
    agentId: draft.agentId,
    modelRefId: draft.modelRefId,
    thinkingLevel: resolveSupportedThinkingLevel(modelRef, draft.thinkingLevel ?? agent.defaultThinkingLevel ?? "off"),
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(sessions).values(session).run();
  return c.json(serializeSession(session), 201);
});

app.patch("/api/sessions/:id", jsonValidator(sessionPatchRequestSchema), async (c) => {
  const patch = c.req.valid("json") as Partial<Session>;
  const sessionId = c.req.param("id");
  const current = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!current || current.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
  if (patch.modelRefId && !canUseModel(c.get("user").id, patch.modelRefId)) return c.json({ error: "Model not found." }, 404);
  const updated: Session = {
    ...current,
    title: patch.title ?? current.title,
    modelRefId: patch.modelRefId ?? current.modelRefId,
    thinkingLevel: patch.thinkingLevel ?? current.thinkingLevel,
    messages: patch.messages ?? current.messages,
    forkedFrom: patch.forkedFrom ?? current.forkedFrom ?? undefined,
    id: sessionId,
    updatedAt: now(),
  };
  db.update(sessions)
    .set({
      title: updated.title,
      userId: updated.userId,
      agentId: updated.agentId,
      modelRefId: updated.modelRefId,
      thinkingLevel: updated.thinkingLevel,
      messages: updated.messages,
      forkedFrom: updated.forkedFrom,
      updatedAt: updated.updatedAt,
    })
    .where(eq(sessions.id, sessionId))
    .run();
  return c.json(serializeSession(updated));
});

app.post("/api/sessions/:id/fork", jsonValidator(forkSessionRequestSchema), async (c) => {
  const sessionId = c.req.param("id");
  const body = c.req.valid("json");
  const source = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!source || source.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
  const timestamp = now();
  const fork: Session = {
    ...source,
    id: id("session"),
    title: `${source.title} fork`,
    messages: source.messages.slice(0, body.messageIndex + 1),
    forkedFrom: { sessionId, messageIndex: body.messageIndex },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(sessions).values(fork).run();
  return c.json(serializeSession(fork), 201);
});

app.delete("/api/sessions/:id", (c) => {
  const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
  if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
  db.delete(sessions).where(eq(sessions.id, session.id)).run();
  return c.json({ ok: true });
});

function readBootstrapPayload(userId: string) {
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
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(serializeSessionMetadata),
  };
}

function readUserProviderConfigs(userId: string) {
  return db.select().from(providerConfigs).where(eq(providerConfigs.userId, userId)).all();
}

function readVisibleAgents(userId: string) {
  return db
    .select()
    .from(agents)
    .all()
    .filter((agent) => agent.ownerUserId === userId || agent.shared);
}

function readVisibleAgent(userId: string, agentId: string) {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent || (agent.ownerUserId !== userId && !agent.shared)) return undefined;
  return agent;
}

function readVisibleModelRefs(userId: string) {
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

function ownsProviderConfig(userId: string, providerConfigId: string) {
  return Boolean(
    db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, providerConfigId))
      .get()?.userId === userId,
  );
}

function canUseModel(userId: string, model: string | typeof modelRefs.$inferSelect) {
  const modelRef = typeof model === "string" ? db.select().from(modelRefs).where(eq(modelRefs.id, model)).get() : model;
  if (!modelRef) return false;
  return (
    modelRef.ownerUserId === userId ||
    modelRef.shared ||
    !modelRef.providerConfigId ||
    ownsProviderConfig(userId, modelRef.providerConfigId)
  );
}

function resolveSupportedThinkingLevel(modelRef: typeof modelRefs.$inferSelect, thinkingLevel: AgentThinkingLevel) {
  const providerConfig = modelRef.providerConfigId
    ? db.select().from(providerConfigs).where(eq(providerConfigs.id, modelRef.providerConfigId)).get()
    : undefined;
  return clampThinkingLevel(
    resolveServerModelRef(serializeModelRef(modelRef), providerConfig),
    thinkingLevel,
  ) as AgentThinkingLevel;
}

function resolveAgentWorkingDir(
  agent: AgentConfig,
  agentId: string,
  current?: typeof agents.$inferSelect,
) {
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

function reassignModelReferences(deletedModelIds: Set<string>) {
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

function readAffectedModelUserIds(deletedModelIds: Set<string>) {
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

function readFallbackModelForUser(userId: string, deletedModelIds: Set<string>) {
  return readVisibleModelRefs(userId).find((model) => !deletedModelIds.has(model.id));
}

function hasProviderAuth(authStorage: AuthStorage, provider: string) {
  return isAuthOptionalProvider(provider) || authStorage.hasAuth(provider);
}

function ensureOptionalProviderAuth(authStorage: AuthStorage, provider: string) {
  if (isAuthOptionalProvider(provider) && !authStorage.hasAuth(provider)) {
    authStorage.setRuntimeApiKey(provider, "ollama");
  }
}

function isAuthOptionalProvider(provider: string) {
  return provider === OLLAMA_PROVIDER;
}

async function listOllamaModels(baseUrl: string): Promise<ProviderModelSummary[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(resolveOllamaTagsUrl(baseUrl), { signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
    const payload = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
    return (payload.models ?? [])
      .map((model) => {
        const modelId = typeof model.name === "string" ? model.name : typeof model.model === "string" ? model.model : "";
        return modelId.trim();
      })
      .filter(Boolean)
      .map((modelId) => ({
        id: modelId,
        name: modelId,
        api: "openai-completions" as const,
        input: ["text" as const],
      }));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out connecting to Ollama.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveOllamaTagsUrl(baseUrl: string) {
  const url = new URL(baseUrl || DEFAULT_OLLAMA_BASE_URL);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${path}/api/tags`;
  url.search = "";
  url.hash = "";
  return url;
}

const clientDistDir = process.env.CLIENT_DIST_DIR ?? fileURLToPath(new URL("../../client/dist/", import.meta.url));
if (existsSync(clientDistDir)) {
  app.use("*", serveStatic({ root: clientDistDir }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();
    return c.html(await readFile(join(clientDistDir, "index.html"), "utf-8"));
  });
}

const port = Number(process.env.PORT ?? 8797);
const hostname = process.env.HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`Carmel agent listening on http://${hostname}:${info.port}`);
});
