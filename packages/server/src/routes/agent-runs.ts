import { type ActiveAgentRunSummary, agentRunRequestSchema, type PromptInput } from "@carmel-agent/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
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
import { createRunStream, getActiveSessionIdsForUser } from "../runtime/run-stream.ts";
import { issueRunAddons, noteIssueRunStarted } from "../services/issues.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { NO_PROVIDER_AUTH_MESSAGE, resolveRunModel } from "../services/model-context.ts";
import { readSessionConnection } from "../services/session-snapshot.ts";
import { jsonValidator } from "../validation.ts";
import { errorMessage } from "../errors.ts";

export function createAgentRunRoutes() {
  const route = new Hono<{ Variables: AuthVariables }>();

  route.get("/agents/:id/active-sessions", (c) => {
    const userId = c.get("user").id;
    const agent = readVisibleAgent(userId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const activeSessionIds = getActiveSessionIdsForUser(userId);
    if (activeSessionIds.length === 0) return c.json({ sessionIds: [] });
    const listed = db.select({ id: sessions.id }).from(sessions).where(and(
      inArray(sessions.id, activeSessionIds),
      eq(sessions.userId, userId),
      eq(sessions.agentId, agent.id),
      isNull(sessions.archivedAt),
      isNull(sessions.taskId),
      isNull(sessions.issueId),
    )).all();
    return c.json({ sessionIds: listed.map((session) => session.id) });
  });

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
    if (activeRun) return alreadyRunning(c, activeRun);

    // The thinking level is clamped to the model: the run commits it back onto
    // the session, so an unsupported one would otherwise stick.
    const model = await resolveRunModel(
      currentUserId,
      body.modelRefId ?? session.modelRefId,
      body.thinkingLevel ?? session.thinkingLevel,
    );
    if (!model.ok) {
      return model.reason === "not_found"
        ? c.json({ error: "Model not found" }, 404)
        : c.json({ error: NO_PROVIDER_AUTH_MESSAGE }, 400);
    }
    const { modelRef, providerConfig, modelRuntime, thinkingLevel } = model.value;

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
    if (currentActiveRun) return alreadyRunning(c, currentActiveRun);
    if (currentSession.revision !== session.revision) {
      return c.json({ error: "Session changed while preparing the agent run. Retry the request." }, 409);
    }

    const run = startDetachedAgentRun({
      agent,
      session: currentSession,
      modelRef,
      providerConfig,
      modelRuntime,
      thinkingLevel,
      promptInput,
      sessionAddons: issueRunAddons(currentSession.issueId),
    });
    noteIssueRunStarted(currentSession, run);
    return createRunStream(run);
  });

  return route;
}

/** The run summary rides at the top level, where clients fall back to it when the header is missing. */
function alreadyRunning(c: Context<{ Variables: AuthVariables }>, run: ActiveAgentRunSummary) {
  c.header("x-agent-run-id", run.runId);
  return c.json({ error: "Session already has an active agent run.", ...run }, 409);
}
