import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { PromptInput } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { modelRefs, providerConfigs, providerKeys, sessions } from "../db/schema.ts";
import {
  abortAgentRun,
  createAgentRunEventStream,
  createAgentRunResponse,
  getActiveAgentRunForSession,
  normalizePromptInput,
} from "../runtime/agent-runtime.ts";
import { createProviderConfigAuthStorage } from "../runtime/auth-storage.ts";
import { canUseModel, readVisibleAgent } from "../services/agent-access.ts";
import { ensureOptionalProviderAuth, hasProviderAuth } from "../services/provider-auth.ts";
import { agentRunRequestSchema, jsonValidator } from "../validation.ts";

export function createAgentRunRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.post("/agent-runs/:runId/abort", (c) => {
    const aborted = abortAgentRun(c.get("user").id, c.req.param("runId"));
    if (!aborted) return c.json({ error: "Agent run not found" }, 404);
    return c.json({ ok: true });
  });

  route.get("/agent-runs/:runId/events", (c) => {
    const response = createAgentRunEventStream(c.get("user").id, c.req.param("runId"));
    if (!response) return c.json({ error: "Agent run not found" }, 404);
    return response;
  });

  route.get("/sessions/:id/active-run", (c) => {
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    return c.json(getActiveAgentRunForSession(c.get("user").id, session.id) ?? null);
  });

  route.post("/agents/:id/run", jsonValidator(agentRunRequestSchema), async (c) => {
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
    const activeRun = getActiveAgentRunForSession(currentUserId, session.id);
    if (activeRun) {
      c.header("x-agent-run-id", activeRun.runId);
      return c.json({ error: "Session already has an active agent run.", ...activeRun }, 409);
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
    const authStorage = providerConfig
      ? createProviderConfigAuthStorage(providerConfig, modelRef.provider)
      : AuthStorage.inMemory();
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

  return route;
}
