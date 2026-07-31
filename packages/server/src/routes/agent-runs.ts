import type { PromptInput } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import {
  abortAgentRun,
  createAgentRunEventStream,
  createAgentRunResponse,
  getActiveAgentRunForSession,
  normalizePromptInput,
} from "../runtime/agent-runtime.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { resolveModelContext } from "../services/model-context.ts";
import { loadSession } from "../services/session-store.ts";
import { agentRunRequestSchema, jsonValidator } from "../validation.ts";

export function readSessionConnection(userId: string, sessionId: string) {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session || session.userId !== userId) return undefined;
  const loadedSession = loadSession(session.id);
  if (!loadedSession) return undefined;
  return {
    session: loadedSession,
    activeRun: getActiveAgentRunForSession(userId, session.id) ?? null,
  };
}

export function createAgentRunRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.post("/agent-runs/:runId/abort", (c) => {
    const aborted = abortAgentRun(c.get("user").id, c.req.param("runId"));
    if (!aborted) return c.json({ error: "Agent run not found" }, 404);
    return c.json({ ok: true });
  });

  route.get("/agent-runs/:runId/events", (c) => {
    const rawCursor = c.req.query("after");
    const afterSequence = rawCursor === undefined ? 0 : Number(rawCursor);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return c.json({ error: "Invalid event cursor" }, 400);
    }
    const response = createAgentRunEventStream(c.get("user").id, c.req.param("runId"), afterSequence);
    if (!response) return c.json({ error: "Agent run not found" }, 404);
    return response;
  });

  route.get("/sessions/:id/active-run", (c) => {
    const session = db.select().from(sessions).where(eq(sessions.id, c.req.param("id"))).get();
    if (!session || session.userId !== c.get("user").id) return c.json({ error: "Session not found" }, 404);
    return c.json(getActiveAgentRunForSession(c.get("user").id, session.id) ?? null);
  });

  route.get("/sessions/:id/connection", (c) => {
    const connection = readSessionConnection(c.get("user").id, c.req.param("id"));
    return connection ? c.json(connection) : c.json({ error: "Session not found" }, 404);
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

    const modelContext = await resolveModelContext(
      currentUserId,
      body.modelRefId ?? session.modelRefId,
    );
    if (!modelContext.ok) {
      return modelContext.reason === "not_found"
        ? c.json({ error: "Model not found" }, 404)
        : c.json({ error: "No API key or OAuth login configured for this model provider." }, 400);
    }
    const { modelRef, providerConfig, modelRuntime } = modelContext.value;

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
      modelRuntime,
      thinkingLevel: body.thinkingLevel ?? session.thinkingLevel,
      promptInput,
    });
  });

  return route;
}
