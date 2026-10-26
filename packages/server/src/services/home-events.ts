import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentRunResult, AgentThinkingLevel, PromptInput } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { agentHomes, homeEvents, sessions } from "../db/schema.ts";
import { imInbox, imIntegrations } from "../db/im-schema.ts";
import { id, now } from "../db/seed.ts";
import { ensureHome, HomeError, readHome } from "./agent-homes.ts";
import { readVisibleAgent } from "./agent-access.ts";
import { resolveRunModel } from "./model-context.ts";
import { hasPendingPiSessionWork, withPiSession } from "./pi-session-storage.ts";
import { readSessionSnapshot } from "./session-snapshot.ts";
import { blockingUserRequest } from "./user-requests.ts";
import { enqueueImMessage } from "./im-integrations.ts";
import { resolveNotificationIntegration } from "./im-integrations.ts";
import { defineDoc } from "@earendil-works/pi-durable";
import { startDetachedAgentRun } from "../runtime/agent-runtime.ts";
import {
  abortAgentRun,
  getActiveAgentRunForSession,
  whenRunFinished,
} from "../runtime/run-stream.ts";

export type HomeEvent = typeof homeEvents.$inferSelect;
const admitting = new Set<string>();
const jobs = new Set<Promise<unknown>>();
let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;

const HomePublications = defineDoc({
  kind: "carmel.home-publications",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}) as Record<string, number>,
  checkpointWhen: () => false,
});

export function publishHomeEvent(
  userId: string,
  agentId: string,
  input: {
    sourceKey: string;
    kind: "issue" | "notification" | "notice";
    text: string;
    notifyPlatform?: import("@carmel-agent/shared").ImPlatform;
  },
) {
  if (!readVisibleAgent(userId, agentId)) return;
  let home;
  try {
    home = ensureHome(userId, agentId);
  } catch (error) {
    if (error instanceof HomeError) return;
    throw error;
  }
  let integrationId: string | undefined;
  if (input.notifyPlatform) {
    try {
      integrationId = resolveNotificationIntegration(userId, agentId, input.notifyPlatform).id;
    } catch {
      /* Home retains the outcome when IM is unavailable. */
    }
  }
  db.insert(homeEvents)
    .values({
      id: id("home_event"),
      sessionId: home.sessionId,
      sourceKey: `${home.sessionId}:${input.sourceKey}`,
      kind: input.kind,
      origin: "background",
      integrationId,
      prompt: { text: input.text.slice(0, 16000) },
      status: "queued",
      createdAt: now(),
    })
    .onConflictDoNothing()
    .run();
  return db
    .select()
    .from(homeEvents)
    .where(eq(homeEvents.sourceKey, `${home.sessionId}:${input.sourceKey}`))
    .get();
}

async function publishNotice(event: HomeEvent) {
  const added = await withPiSession(event.sessionId, async (pi) =>
    pi.conversation.commit(async (tx) => {
      const published = await tx.doc(HomePublications, pi.conversation.id);
      if (published[event.id]) return false;
      const entry = await tx.appendEntry(pi.conversation.id, {
        kind: "carmel.notice",
        data: { text: event.prompt.text, timestamp: event.createdAt, homeEventId: event.id },
      });
      published[event.id] = entry.id;
      return true;
    }, BACKGROUND_CONTEXT),
  );
  if (!added) return;
  db.update(agentHomes)
    .set({ updatedAt: Math.max(now(), event.createdAt) })
    .where(eq(agentHomes.sessionId, event.sessionId))
    .run();
}

export function queuedHomeInputs(sessionId: string) {
  return db
    .select({ count: sql<number>`count(*)` })
    .from(homeEvents)
    .where(
      and(
        eq(homeEvents.sessionId, sessionId),
        eq(homeEvents.kind, "input"),
        inArray(homeEvents.status, ["preparing", "queued"]),
      ),
    )
    .get()!.count;
}

export function admitHomeInput(
  userId: string,
  agentId: string,
  input: {
    sourceKey: string;
    prompt: PromptInput;
    origin: HomeEvent["origin"];
    integrationId?: string;
    preparing?: boolean;
    modelRefId?: string;
    thinkingLevel?: AgentThinkingLevel;
    timezone?: string;
  },
) {
  if (!input.prompt.text.trim() && !input.prompt.images?.length && !input.prompt.references?.length)
    throw new HomeError("Enter a message or attach a reference.", 400);
  const home = ensureHome(userId, agentId);
  const key = `${home.sessionId}:${input.sourceKey}`;
  const existing = db.select().from(homeEvents).where(eq(homeEvents.sourceKey, key)).get();
  if (existing) return existing;
  if (blockingUserRequest(home.sessionId))
    throw new HomeError("Respond to the pending request in Home before sending another message.");
  if (queuedHomeInputs(home.sessionId) >= 20)
    throw new HomeError("The Home message queue is full. Wait for a reply or stop Home.");
  const eventId = id("home_event");
  db.transaction(() => {
    db.insert(homeEvents)
      .values({
        id: eventId,
        sessionId: home.sessionId,
        sourceKey: key,
        kind: "input",
        origin: input.origin,
        integrationId: input.integrationId,
        prompt: input.prompt,
        status: input.preparing ? "preparing" : "queued",
        modelRefId: input.modelRefId,
        thinkingLevel: input.thinkingLevel,
        timezone: input.timezone,
        createdAt: now(),
      })
      .run();
    db.update(agentHomes)
      .set({ paused: false })
      .where(eq(agentHomes.sessionId, home.sessionId))
      .run();
  });
  return db.select().from(homeEvents).where(eq(homeEvents.id, eventId)).get()!;
}

export async function stopHome(userId: string, agentId: string) {
  const home = readHome(userId, agentId);
  if (!home) return;
  db.transaction(() => {
    db.update(agentHomes)
      .set({ paused: true })
      .where(eq(agentHomes.sessionId, home.sessionId))
      .run();
    db.update(homeEvents)
      .set({ status: "cancelled", finishedAt: now() })
      .where(
        and(
          eq(homeEvents.sessionId, home.sessionId),
          eq(homeEvents.kind, "input"),
          inArray(homeEvents.status, ["preparing", "queued"]),
        ),
      )
      .run();
    const integrations = db
      .select({ id: imIntegrations.id })
      .from(imIntegrations)
      .where(and(eq(imIntegrations.userId, userId), eq(imIntegrations.agentId, agentId)))
      .all();
    for (const integration of integrations)
      db.update(imInbox)
        .set({ status: "interrupted" })
        .where(and(eq(imInbox.integrationId, integration.id), eq(imInbox.status, "queued")))
        .run();
  });
  const active = getActiveAgentRunForSession(userId, home.sessionId);
  if (active) abortAgentRun(userId, active.runId);
  else await withPiSession(home.sessionId, (pi) => pi.conversation.abort(BACKGROUND_CONTEXT));
}

async function settleHomeEvent(event: HomeEvent, result: AgentRunResult) {
  const session = db.select().from(sessions).where(eq(sessions.id, event.sessionId)).get();
  if (!session) return;
  const snapshot = await readSessionSnapshot(session.userId, event.sessionId);
  const last = snapshot?.messages.findLast((message) => message.role === "assistant");
  const waiting = blockingUserRequest(session.id);
  const reply = waiting
    ? `The agent needs your input. [Open Home](/agents/${session.agentId}/home) to respond.`
    : result.outcome === "succeeded" && last?.role === "assistant"
      ? last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n\n")
      : `The reply ${result.outcome === "succeeded" ? "finished without text" : result.outcome}. Open Home for details.`;
  db.transaction(() => {
    db.update(homeEvents)
      .set({
        status:
          result.outcome === "succeeded"
            ? "done"
            : result.outcome === "interrupted"
              ? "interrupted"
              : "failed",
        reply,
        error: result.detail ?? null,
        finishedAt: now(),
      })
      .where(eq(homeEvents.id, event.id))
      .run();
    db.update(imInbox)
      .set({ status: result.outcome === "interrupted" ? "interrupted" : "done" })
      .where(eq(imInbox.homeEventId, event.id))
      .run();
    if (event.integrationId) {
      const integration = db
        .select()
        .from(imIntegrations)
        .where(eq(imIntegrations.id, event.integrationId))
        .get();
      if (
        integration?.enabled &&
        (event.origin !== "background" || integration.proactive) &&
        integration.userId === session.userId &&
        integration.agentId === session.agentId
      )
        enqueueImMessage(
          integration.id,
          reply.slice(0, 100_000) || "Open Home to see the result.",
          `home-result:${event.id}`,
          event.origin === "background",
          session.id,
          event.id,
        );
    }
  });
}

export async function dispatchHome(sessionId: string) {
  if (stopped || admitting.has(sessionId)) return;
  const home = db.select().from(agentHomes).where(eq(agentHomes.sessionId, sessionId)).get();
  if (
    !home ||
    getActiveAgentRunForSession(home.userId, sessionId) ||
    db
      .select()
      .from(homeEvents)
      .where(and(eq(homeEvents.sessionId, sessionId), eq(homeEvents.status, "running")))
      .get()
  )
    return;
  const event = db
    .select()
    .from(homeEvents)
    .where(
      and(eq(homeEvents.sessionId, sessionId), inArray(homeEvents.status, ["preparing", "queued"])),
    )
    .orderBy(asc(homeEvents.createdAt), sql`rowid`)
    .get();
  if (!event || event.status === "preparing") return;
  admitting.add(sessionId);
  try {
    if (event.kind !== "input") {
      await publishNotice(event);
      if (event.kind !== "issue") {
        db.update(homeEvents)
          .set({ status: "done", reply: event.prompt.text, finishedAt: now() })
          .where(eq(homeEvents.id, event.id))
          .run();
        return;
      }
      if (home.paused) return;
    }
    if (blockingUserRequest(sessionId)) return;
    if (await hasPendingPiSessionWork(sessionId)) return;
    const agent = readVisibleAgent(home.userId, home.agentId);
    if (!agent) throw new HomeError("This agent is no longer available.", 404);
    if (event.integrationId) {
      const integration = db
        .select()
        .from(imIntegrations)
        .where(eq(imIntegrations.id, event.integrationId))
        .get();
      if (
        !integration?.enabled ||
        integration.userId !== home.userId ||
        integration.agentId !== home.agentId
      )
        throw new HomeError("The messaging integration is no longer available.");
    }
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
    const model = await resolveRunModel(
      home.userId,
      event.modelRefId ?? session.modelRefId,
      event.thinkingLevel ?? session.thinkingLevel,
    );
    if (!model.ok)
      throw new HomeError(
        "The agent's model is unavailable. Configure a usable model in Carmel.",
        400,
      );
    const current = db.select().from(homeEvents).where(eq(homeEvents.id, event.id)).get();
    if (
      stopped ||
      current?.status !== "queued" ||
      getActiveAgentRunForSession(home.userId, sessionId)
    )
      return;
    const run = startDetachedAgentRun({
      agent,
      session,
      ...model.value,
      promptInput:
        event.kind === "input"
          ? event.prompt
          : {
              text: `A background job reported the following source material. Briefly tell the user the result or decision needed, with its link. Do not accept the result, repeat completed work, or start another job unless the user asked.\n\n${event.prompt.text}`,
            },
      timezone: event.timezone ?? undefined,
      promptDelivery: {
        requestId: `home:${event.id}`,
        source: {
          homeEventId: event.id,
          origin: event.origin,
          ...(event.integrationId ? { integrationId: event.integrationId } : {}),
        },
      },
    });
    db.update(homeEvents)
      .set({ status: "running", runId: run.runId })
      .where(eq(homeEvents.id, event.id))
      .run();
    db.update(imInbox)
      .set({ status: "running", sessionId, runId: run.runId })
      .where(eq(imInbox.homeEventId, event.id))
      .run();
    const pending = whenRunFinished(run)
      .then((result) => settleHomeEvent(event, result))
      .catch((error) => {
        db.update(homeEvents)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : "Unable to save the reply.",
            finishedAt: now(),
          })
          .where(eq(homeEvents.id, event.id))
          .run();
      })
      .finally(() => {
        jobs.delete(pending);
      });
    jobs.add(pending);
    return run;
  } catch (error) {
    await settleHomeEvent(event, {
      outcome: "failed",
      detail: error instanceof Error ? error.message : "Unable to start the reply.",
    });
  } finally {
    admitting.delete(sessionId);
  }
}

export async function recoverHomeEvents() {
  for (const event of db
    .select()
    .from(homeEvents)
    .where(eq(homeEvents.status, "preparing"))
    .all()) {
    if (!event.integrationId)
      db.update(homeEvents)
        .set({ status: "failed", error: "Input preparation was interrupted." })
        .where(eq(homeEvents.id, event.id))
        .run();
  }
  for (const event of db.select().from(homeEvents).where(eq(homeEvents.status, "running")).all()) {
    const settled = await withPiSession(event.sessionId, async (pi) => {
      const submission = await pi.native.commit(
        (tx) => tx.submissionByRequest(pi.conversation.id, `home:${event.id}`),
        BACKGROUND_CONTEXT,
      );
      return submission?.status === "done";
    });
    await settleHomeEvent(
      event,
      settled
        ? { outcome: "succeeded" }
        : {
            outcome: "interrupted",
            detail:
              "The server restarted during this reply. Resume or stop it in Home before sending it again.",
          },
    );
  }
}

export function startHomeDispatcher() {
  stopped = false;
  timer ??= setInterval(() => {
    for (const home of db.select().from(agentHomes).all()) void dispatchHome(home.sessionId);
  }, 500);
  timer.unref();
}
export function stopHomeDispatcher() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
}
export async function drainHomeEvents() {
  await Promise.allSettled(jobs);
}
