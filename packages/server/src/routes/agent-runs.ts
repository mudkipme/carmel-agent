import type { PromptInput } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AuthVariables } from "../auth.ts";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import {
  abortAgentRun,
  createAgentRunEventStream,
  getActiveAgentRunForSession,
  normalizePromptInput,
  startDetachedAgentRun,
} from "../runtime/agent-runtime.ts";
import { createRunStream } from "../runtime/run-stream.ts";
import { issueRunAddons, noteIssueRunStarted } from "../services/issues.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { resolveModelContext } from "../services/model-context.ts";
import { readSessionConnection } from "../services/session-snapshot.ts";
import { agentRunRequestSchema, jsonValidator } from "../validation.ts";
import { errorMessage } from "../errors.ts";

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

  route.get("/sessions/:id/connection", async (c) => {
    const connection = await readSessionConnection(c.get("user").id, c.req.param("id"));
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
      return c.json({ error: errorMessage(error) }, 400);
    }

    // Model/auth resolution can yield to other requests. Revalidate the session
    // lease immediately before synchronously registering the active run.
    const currentSession = db.select().from(sessions).where(eq(sessions.id, session.id)).get();
    if (!currentSession || currentSession.userId !== currentUserId || currentSession.agentId !== agent.id) {
      return c.json({ error: "Session not found" }, 404);
    }
    const currentActiveRun = getActiveAgentRunForSession(currentUserId, currentSession.id);
    if (currentActiveRun) {
      c.header("x-agent-run-id", currentActiveRun.runId);
      return c.json({ error: "Session already has an active agent run.", ...currentActiveRun }, 409);
    }
    if (currentSession.revision !== session.revision) {
      return c.json({ error: "Session changed while preparing the agent run. Retry the request." }, 409);
    }

    const run = startDetachedAgentRun({
      agent,
      session: currentSession,
      modelRef,
      providerConfig,
      modelRuntime,
      thinkingLevel: body.thinkingLevel ?? currentSession.thinkingLevel,
      promptInput,
      sessionAddons: issueRunAddons(currentSession.issueId),
    });
    noteIssueRunStarted(currentSession, run);
    return createRunStream(run);
  });

  return route;
}
