import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAgentRunResponse, normalizePromptInput } from "./runtime/agent-runtime";
import { createAgentResourceLoader } from "./runtime/resources";
import { db, migrate, seed } from "./db";
import { agents, modelRefs, providerConfigs, providerKeys, sessions, users } from "./db/schema";
import { id, now } from "./db/seed";
import {
  serializeModelRef,
  serializeProviderConfig,
  serializePublicAgent,
  serializeSession,
} from "./serializers";
import type { AgentConfig, ModelRef, PromptInput, ProviderConfig, Session, SessionDraft, User } from "@carmel-agent/shared";

migrate();
seed();

const app = new Hono();

app.use(
  "/api/*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/bootstrap", (c) => {
  return c.json(readBootstrapPayload());
});

app.put("/api/users/:id", async (c) => {
  const user = (await c.req.json()) as User;
  const timestamp = now();
  db.insert(users)
    .values({ ...user, id: c.req.param("id"), createdAt: timestamp, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: users.id,
      set: { name: user.name, email: user.email, updatedAt: timestamp },
    })
    .run();
  return c.json(db.select().from(users).where(eq(users.id, c.req.param("id"))).get());
});

app.put("/api/models/:id", async (c) => {
  const model = (await c.req.json()) as ModelRef;
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
      input: model.input ?? ["text"],
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: modelRefs.id,
      set: {
        label: model.label,
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
  const modelId = c.req.param("id");
  const fallbackModel = db.select().from(modelRefs).all().find((model) => model.id !== modelId);
  if (!fallbackModel) return c.json({ error: "Create another model before deleting the last model." }, 409);
  reassignModelReferences(new Set([modelId]), fallbackModel.id);
  db.delete(modelRefs).where(eq(modelRefs.id, modelId)).run();
  return c.json(readBootstrapPayload());
});

app.put("/api/provider-configs/:id", async (c) => {
  const providerConfig = (await c.req.json()) as ProviderConfig;
  const timestamp = now();
  const current = db.select().from(providerConfigs).where(eq(providerConfigs.id, c.req.param("id"))).get();
  const apiKey = providerConfig.apiKey ?? current?.apiKey ?? null;
  db.insert(providerConfigs)
    .values({
      ...providerConfig,
      id: c.req.param("id"),
      apiKey,
      createdAt: providerConfig.createdAt ?? timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: providerConfigs.id,
      set: {
        userId: providerConfig.userId,
        label: providerConfig.label,
        provider: providerConfig.provider,
        apiKey,
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

app.delete("/api/provider-configs/:id", (c) => {
  const providerConfigId = c.req.param("id");
  const relatedModels = db.select().from(modelRefs).where(eq(modelRefs.providerConfigId, providerConfigId)).all();
  const deletedModelIds = new Set(relatedModels.map((model) => model.id));
  if (deletedModelIds.size > 0) {
    const fallbackModel = db.select().from(modelRefs).all().find((model) => !deletedModelIds.has(model.id));
    if (!fallbackModel) {
      return c.json({ error: "Create another provider/model before deleting the last configured models." }, 409);
    }
    reassignModelReferences(deletedModelIds, fallbackModel.id);
  }

  db.delete(modelRefs).where(eq(modelRefs.providerConfigId, providerConfigId)).run();
  db.delete(providerConfigs).where(eq(providerConfigs.id, providerConfigId)).run();
  return c.json(readBootstrapPayload());
});

app.put("/api/agents/:id", async (c) => {
  const agent = (await c.req.json()) as AgentConfig;
  const timestamp = now();
  db.insert(agents)
    .values({ ...agent, id: c.req.param("id"), createdAt: agent.createdAt ?? timestamp, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        ownerUserId: agent.ownerUserId,
        shared: agent.shared,
        name: agent.name,
        description: agent.description,
        workingDir: agent.workingDir,
        skills: agent.skills,
        systemPrompt: agent.systemPrompt,
        promptTemplates: agent.promptTemplates,
        permissions: agent.permissions,
        defaultModelRefId: agent.defaultModelRefId,
        updatedAt: timestamp,
      },
    })
    .run();
  return c.json(serializePublicAgent(db.select().from(agents).where(eq(agents.id, c.req.param("id"))).get()!));
});

app.delete("/api/agents/:id", (c) => {
  const agentId = c.req.param("id");
  db.delete(sessions).where(eq(sessions.agentId, agentId)).run();
  db.delete(agents).where(eq(agents.id, agentId)).run();
  return c.json({ ok: true });
});

app.get("/api/agents/:id/settings", (c) => {
  const agent = db.select().from(agents).where(eq(agents.id, c.req.param("id"))).get();
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  if (agent.ownerUserId !== c.req.query("userId")) return c.json({ error: "Agent settings are owner-only." }, 403);
  return c.json(agent);
});

app.get("/api/agents/:id/commands", async (c) => {
  const agent = db.select().from(agents).where(eq(agents.id, c.req.param("id"))).get();
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  const userId = c.req.query("userId");
  if (agent.ownerUserId !== userId && !agent.shared) return c.json({ error: "Agent not found" }, 404);
  const resourceLoader = await createAgentResourceLoader(agent);
  const { skills } = resourceLoader.getSkills();
  return c.json({
    promptTemplates: agent.promptTemplates,
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
    })),
  });
});

app.post("/api/agents/:id/run", async (c) => {
  const agent = db.select().from(agents).where(eq(agents.id, c.req.param("id"))).get();
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const body = (await c.req.json()) as {
    sessionId?: string;
    modelRefId?: string;
    thinkingLevel?: Session["thinkingLevel"];
    promptInput?: PromptInput;
  };
  const session = body.sessionId
    ? db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get()
    : undefined;
  if (!session || session.agentId !== agent.id) return c.json({ error: "Session not found" }, 404);

  const modelRef = db
    .select()
    .from(modelRefs)
    .where(eq(modelRefs.id, body.modelRefId ?? session.modelRefId))
    .get();
  if (!modelRef) return c.json({ error: "Model not found" }, 404);

  const providerConfig = modelRef.providerConfigId
    ? db.select().from(providerConfigs).where(eq(providerConfigs.id, modelRef.providerConfigId)).get()
    : undefined;
  const providerKey = db
    .select()
    .from(providerKeys)
    .where(eq(providerKeys.userId, session.userId))
    .all()
    .find((item) => item.provider === modelRef.provider);
  const apiKey = providerConfig?.apiKey ?? providerKey?.apiKey;
  if (!apiKey) return c.json({ error: "No API key configured for this model provider." }, 400);

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
    apiKey,
    thinkingLevel: body.thinkingLevel ?? session.thinkingLevel,
    promptInput,
  });
});

app.get("/api/sessions/:id", (c) => {
  const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
  if (!session) return c.json({ error: "Session not found" }, 404);
  return c.json(serializeSession(session));
});

app.post("/api/sessions", async (c) => {
  const draft = (await c.req.json()) as SessionDraft & { userId: string; title?: string };
  const timestamp = now();
  const session: Session = {
    id: id("session"),
    title: draft.title ?? "Untitled session",
    userId: draft.userId,
    agentId: draft.agentId,
    modelRefId: draft.modelRefId,
    thinkingLevel: draft.thinkingLevel,
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(sessions).values(session).run();
  return c.json(serializeSession(session), 201);
});

app.patch("/api/sessions/:id", async (c) => {
  const patch = (await c.req.json()) as Partial<Session>;
  const sessionId = c.req.param("id");
  const current = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!current) return c.json({ error: "Session not found" }, 404);
  const updated: Session = {
    ...current,
    title: patch.title ?? current.title,
    modelRefId: patch.modelRefId ?? current.modelRefId,
    thinkingLevel: patch.thinkingLevel ?? current.thinkingLevel,
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

app.post("/api/sessions/:id/fork", async (c) => {
  const sessionId = c.req.param("id");
  const body = (await c.req.json()) as { messageIndex: number };
  const source = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!source) return c.json({ error: "Session not found" }, 404);
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
  db.delete(sessions).where(eq(sessions.id, c.req.param("id"))).run();
  return c.json({ ok: true });
});

function readBootstrapPayload() {
  return {
    users: db.select().from(users).all(),
    agents: db.select().from(agents).all().map(serializePublicAgent),
    providerConfigs: db.select().from(providerConfigs).all().map(serializeProviderConfig),
    modelRefs: db.select().from(modelRefs).all().map(serializeModelRef),
    sessions: db.select().from(sessions).all().map(serializeSession),
  };
}

function reassignModelReferences(deletedModelIds: Set<string>, fallbackModelId: string) {
  const timestamp = now();
  const affectedAgents = db
    .select()
    .from(agents)
    .all()
    .filter((agent) => deletedModelIds.has(agent.defaultModelRefId));

  for (const agent of affectedAgents) {
    db.update(agents)
      .set({ defaultModelRefId: fallbackModelId, updatedAt: timestamp })
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
    db.update(sessions)
      .set({
        modelRefId:
          agentDefaultModelId && !deletedModelIds.has(agentDefaultModelId)
            ? agentDefaultModelId
            : fallbackModelId,
        updatedAt: timestamp,
      })
      .where(eq(sessions.id, session.id))
      .run();
  }
}

const port = Number(process.env.PORT ?? 8797);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Carmel agent API listening on http://localhost:${info.port}`);
});
