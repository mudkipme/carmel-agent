import { and, asc, desc, eq } from "drizzle-orm";
import { BACKGROUND_CONTEXT } from "../effectors/pi-durable/index.ts";
import type {
  Issue,
  IssueCreateCommand,
  IssueDetail,
  IssuePatchCommand,
  IssueRunCommand,
  IssueVerdict,
  AgentRunResult,
} from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { issues, issueAttempts, issueNotes, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { errorMessage } from "../errors.ts";
import {
  startDetachedAgentRun,
  steerAgentRun,
  type SessionRunAddons,
} from "../runtime/agent-runtime.ts";
import {
  abortAgentRun,
  getActiveAgentRunForSessionId,
  onRunFinished,
} from "../runtime/run-stream.ts";
import { readVisibleAgent } from "./agent-access.ts";
import { NO_PROVIDER_AUTH_MESSAGE, resolveRunModel } from "./model-context.ts";
import { deletePiSession } from "./pi-session-storage.ts";
import { insertSession } from "./session-launch.ts";
import { captureIssueWorkspace, compareIssueWorkspace } from "./issue-results.ts";

type IssueRecord = typeof issues.$inferSelect;
export class IssueError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

// Agent ownership is permanent. Sharing tooling never shares a user's issues.
export function readIssues(userId: string, agentId: string): Issue[] {
  assertAgentVisible(userId, agentId);
  return db
    .select()
    .from(issues)
    .where(and(eq(issues.agentId, agentId), eq(issues.userId, userId)))
    .orderBy(desc(issues.updatedAt))
    .all()
    .map(serializeIssue);
}
export function readIssue(userId: string, agentId: string, issueId: string): IssueRecord {
  assertAgentVisible(userId, agentId);
  const row = db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!row || row.agentId !== agentId || row.userId !== userId)
    throw new IssueError("Issue not found.", 404);
  return row;
}
export function readIssueView(userId: string, agentId: string, issueId: string): IssueDetail {
  const issue = readIssue(userId, agentId, issueId);
  const canReadFiles = assertAgentVisible(userId, agentId).permissions.read;
  return {
    ...serializeIssue(issue),
    attempts: db
      .select()
      .from(issueAttempts)
      .where(eq(issueAttempts.issueId, issueId))
      .orderBy(desc(issueAttempts.createdAt))
      .all()
      .map((attempt) =>
        canReadFiles || !attempt.snapshot
          ? attempt
          : {
              ...attempt,
              snapshot: {
                files: [],
                capturedAt: attempt.snapshot.capturedAt,
                warning: "File review requires the agent's read permission.",
              },
            },
      ),
    notes: db
      .select()
      .from(issueNotes)
      .where(eq(issueNotes.issueId, issueId))
      .orderBy(asc(issueNotes.createdAt))
      .all(),
  };
}
export function createIssue(
  userId: string,
  agentId: string,
  draft: IssueCreateCommand,
): IssueDetail {
  assertAgentVisible(userId, agentId);
  const issueId = id("issue");
  // Legacy session_id is NOT NULL. Empty means no attempt yet; public API omits it.
  db.insert(issues)
    .values({
      title: draft.title,
      description: draft.description,
      criteria: draft.criteria,
      priority: draft.priority,
      id: issueId,
      agentId,
      userId,
      sessionId: "",
      status: draft.status ?? "backlog",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  addEvent(issueId, "Issue created.");
  if (draft.queue) {
    enqueueIssue(userId, agentId, issueId, {});
    wakeQueue(agentId);
  }
  return readIssueView(userId, agentId, issueId);
}
export function addIssueNote(
  userId: string,
  agentId: string,
  issueId: string,
  body: string,
): IssueDetail {
  readIssue(userId, agentId, issueId);
  addEvent(issueId, body, "note");
  db.update(issues).set({ updatedAt: now() }).where(eq(issues.id, issueId)).run();
  return readIssueView(userId, agentId, issueId);
}

const launching = new Set<string>();
let queueEnabled = true;
const settling = new Map<string, Promise<unknown>>();
let queueTimer: ReturnType<typeof setInterval> | undefined;

export function startIssueQueue() {
  queueEnabled = true;
  queueTimer ??= setInterval(() => {
    for (const row of db
      .select({ agentId: issues.agentId })
      .from(issues)
      .where(eq(issues.status, "queued"))
      .all())
      wakeQueue(row.agentId);
  }, 2000);
  queueTimer.unref();
}
export async function drainIssueResults() {
  await Promise.allSettled(settling.values());
}
export function stopIssueQueue() {
  queueEnabled = false;
  if (queueTimer) clearInterval(queueTimer);
  queueTimer = undefined;
}
function wakeQueue(agentId: string) {
  if (!queueEnabled) return;
  setImmediate(() => {
    if (queueEnabled) void pumpIssueQueue(agentId).catch(() => undefined);
  });
}
function enqueueIssue(userId: string, agentId: string, issueId: string, command: IssueRunCommand) {
  const current = readIssue(userId, agentId, issueId);
  requireIdle(current);
  if (closed(current)) throw new IssueError("Reopen the issue before queueing work.", 409);
  if (current.status === "queued") throw new IssueError("This issue is already queued.", 409);
  if (["in_review", "needs_input"].includes(current.status) && !command.instructions?.trim())
    throw new IssueError("Provide feedback or an answer before starting another run.", 400);
  const last = db
    .select()
    .from(issues)
    .where(eq(issues.agentId, agentId))
    .orderBy(desc(issues.queuePosition))
    .get();
  db.update(issues)
    .set({
      status: "queued",
      queuePosition: (last?.queuePosition ?? 0) + 1,
      queuedCommand: command,
      updatedAt: now(),
    })
    .where(eq(issues.id, issueId))
    .run();
  addEvent(
    issueId,
    command.instructions ? `Queued instructions:\n${command.instructions}` : "Queued work.",
  );
}
export async function runIssue(
  userId: string,
  agentId: string,
  issueId: string,
  command: IssueRunCommand,
): Promise<IssueDetail> {
  enqueueIssue(userId, agentId, issueId, command);
  try {
    await pumpIssueQueue(agentId);
  } catch (error) {
    // A failure in an older queued job must not reject admission of this one.
    if (readIssue(userId, agentId, issueId).status !== "queued") throw error;
  }
  return readIssueView(userId, agentId, issueId);
}

/** One claim across all owners of a shared agent. Admission precedes every async step. */
export async function pumpIssueQueue(agentId: string) {
  if (!queueEnabled || launching.has(agentId)) return;
  const active = db
    .select({ id: issueAttempts.id })
    .from(issueAttempts)
    .innerJoin(issues, eq(issues.id, issueAttempts.issueId))
    .where(and(eq(issues.agentId, agentId), eq(issueAttempts.outcome, "running")))
    .get();
  if (active) return;
  const current = db
    .select()
    .from(issues)
    .where(and(eq(issues.agentId, agentId), eq(issues.status, "queued")))
    .orderBy(asc(issues.queuePosition), asc(issues.createdAt), asc(issues.id))
    .get();
  if (!current) return;
  launching.add(agentId);
  const { userId, id: issueId } = current;
  const command = current.queuedCommand ?? {};
  const attemptId = id("attempt");
  const brief = issuePrompt(current);
  db.transaction(() => {
    db.insert(issueAttempts)
      .values({
        id: attemptId,
        issueId,
        instructions: command.instructions ?? "",
        brief,
        outcome: "running",
        createdAt: now(),
      })
      .run();
    db.update(issues)
      .set({
        status: "in_progress",
        queuePosition: null,
        queuedCommand: null,
        verdict: null,
        verdictSummary: null,
        lastRunOutcome: null,
        lastRunDetail: null,
        updatedAt: now(),
      })
      .where(eq(issues.id, issueId))
      .run();
    addEvent(issueId, command.fresh ? "Started work in a fresh conversation." : "Started work.");
  });
  try {
    const agent = assertAgentVisible(userId, agentId);
    const previous =
      !command.fresh && current.sessionId
        ? db.select().from(sessions).where(eq(sessions.id, current.sessionId)).get()
        : undefined;
    const model = await resolveRunModel(
      userId,
      command.modelRefId ?? previous?.modelRefId ?? agent.defaultModelRefId,
      command.thinkingLevel ?? previous?.thinkingLevel ?? agent.defaultThinkingLevel ?? "off",
    );
    checkClaim();
    const currentAgent = assertAgentVisible(userId, agentId);
    if (!model.ok)
      throw new IssueError(
        model.reason === "not_found" ? "Model not found." : NO_PROVIDER_AUTH_MESSAGE,
        400,
      );
    const baseline = await captureIssueWorkspace(currentAgent);
    checkClaim();
    const { modelRef, providerConfig, modelRuntime, thinkingLevel } = model.value;
    const session =
      previous ??
      insertSession({
        userId,
        agentId,
        modelRefId: modelRef.id,
        thinkingLevel,
        issueId,
        title: current.title,
      });
    db.update(issueAttempts)
      .set({ sessionId: session.id })
      .where(eq(issueAttempts.id, attemptId))
      .run();
    db.update(issues).set({ sessionId: session.id }).where(eq(issues.id, issueId)).run();
    const run = startDetachedAgentRun({
      agent: currentAgent,
      session,
      modelRef,
      providerConfig,
      modelRuntime,
      thinkingLevel,
      promptInput: { text: command.instructions || "Work on this issue." },
      sessionAddons: issueRunAddons(issueId, attemptId, brief),
    });
    onRunFinished(run, (result) => {
      // Keep the claim until the immutable result has been saved; the next job cannot overwrite it.
      const settlement = (async () => {
        const snapshot = compareIssueWorkspace(baseline, await captureIssueWorkspace(currentAgent));
        db.update(issueAttempts).set({ snapshot }).where(eq(issueAttempts.id, attemptId)).run();
      })()
        .catch(() => {
          db.update(issueAttempts)
            .set({
              snapshot: {
                files: [],
                capturedAt: now(),
                warning: "File capture failed.",
              },
            })
            .where(eq(issueAttempts.id, attemptId))
            .run();
        })
        .finally(() => {
          finishIssueAttempt(attemptId, result);
          settling.delete(attemptId);
        });
      settling.set(attemptId, settlement);
    });
  } catch (error) {
    finishIssueAttempt(attemptId, {
      outcome: queueEnabled ? "failed" : "interrupted",
      detail: errorMessage(error),
    });
    throw error;
  } finally {
    launching.delete(agentId);
    wakeQueue(agentId);
  }
  function checkClaim() {
    if (!queueEnabled) throw new IssueError("The server stopped before this run could start.", 409);
    const attempt = db.select().from(issueAttempts).where(eq(issueAttempts.id, attemptId)).get();
    if (!attempt || attempt.outcome !== "running")
      throw new IssueError("This attempt was stopped before it started.", 409);
    readIssue(userId, agentId, issueId);
  }
}

export function removeIssueFromQueue(
  userId: string,
  agentId: string,
  issueId: string,
): IssueDetail {
  const current = readIssue(userId, agentId, issueId);
  if (current.status !== "queued")
    throw new IssueError("Only queued work can be removed from the queue.", 409);
  if (current.queuedCommand?.instructions)
    addEvent(issueId, current.queuedCommand.instructions, "note");
  db.update(issues)
    .set({
      status: "backlog",
      queuePosition: null,
      queuedCommand: null,
      updatedAt: now(),
    })
    .where(eq(issues.id, issueId))
    .run();
  addEvent(issueId, "Removed from the queue. Instructions remain in the discussion.");
  return readIssueView(userId, agentId, issueId);
}
export function moveQueuedIssue(
  userId: string,
  agentId: string,
  issueId: string,
  direction: "up" | "down",
): IssueDetail {
  const current = readIssue(userId, agentId, issueId);
  if (current.status !== "queued") throw new IssueError("Only queued work can be reordered.", 409);
  // Users can reorder their own jobs without exposing another owner's private queue.
  const queue = readIssues(userId, agentId)
    .filter((i) => i.status === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const index = queue.findIndex((i) => i.id === issueId);
  const neighbor = queue[index + (direction === "up" ? -1 : 1)];
  if (neighbor)
    db.transaction(() => {
      db.update(issues)
        .set({ queuePosition: neighbor.queuePosition })
        .where(eq(issues.id, issueId))
        .run();
      db.update(issues)
        .set({ queuePosition: current.queuePosition })
        .where(eq(issues.id, neighbor.id))
        .run();
    });
  return readIssueView(userId, agentId, issueId);
}
export async function sendIssueUpdate(
  userId: string,
  agentId: string,
  issueId: string,
  body: string,
): Promise<IssueDetail> {
  const current = readIssue(userId, agentId, issueId);
  if (!activeAttempt(issueId) || !current.sessionId)
    throw new IssueError("The agent is not running. Queue your instructions instead.", 409);
  const noteId = addEvent(issueId, body, "note");
  db.update(issueNotes).set({ delivery: "queued" }).where(eq(issueNotes.id, noteId)).run();
  try {
    const queued = await steerAgentRun(current.sessionId, body);
    if (!queued)
      throw new IssueError(
        "The run is starting or has ended. Your update was saved; queue it to continue.",
        409,
      );
    db.update(issueNotes)
      .set({
        entryId: queued.entryId,
        delivery: queued.pending ? "queued" : "delivered",
      })
      .where(eq(issueNotes.id, noteId))
      .run();
  } catch (error) {
    db.update(issueNotes).set({ delivery: "not_delivered" }).where(eq(issueNotes.id, noteId)).run();
    throw error;
  }
  return readIssueView(userId, agentId, issueId);
}

export function issueRunAddons(
  issueId: string,
  attemptId: string,
  brief?: string,
): SessionRunAddons {
  return {
    instructions: `You are executing one attempt on a durable issue in this agent's workspace. The brief and acceptance criteria are the contract. Runs continue the same conversation unless the user explicitly starts fresh. Inspect existing work before changing it. When you stop, call report_issue as your final action. Use done when ready for human review, needs_input with specific questions, or blocked with the obstacle. Include concrete verification evidence, and distinguish checked results from assumptions. Reporting done never closes the issue; only the user accepts it.${brief ? `\n\n## Issue brief\n\n${brief}` : ""}`,
    onQueueUpdate(entryIds) {
      for (const note of db
        .select()
        .from(issueNotes)
        .where(and(eq(issueNotes.issueId, issueId), eq(issueNotes.delivery, "queued")))
        .all())
        if (note.entryId && !entryIds.includes(note.entryId))
          db.update(issueNotes)
            .set({ delivery: "delivered" })
            .where(eq(issueNotes.id, note.id))
            .run();
    },
    async onRunSettling(lane, aborted) {
      const watch = await lane.watch(BACKGROUND_CONTEXT);
      try {
        const pending = new Set(watch.snapshot.queues.map((item) => item.entryId));
        for (const note of db
          .select()
          .from(issueNotes)
          .where(and(eq(issueNotes.issueId, issueId), eq(issueNotes.delivery, "queued")))
          .all()) {
          if (!note.entryId) continue;
          const undelivered = aborted || pending.has(note.entryId);
          // Set the state before cancellation emits queue_update, so removal
          // cannot be mistaken for successful delivery.
          db.update(issueNotes)
            .set({ delivery: undelivered ? "not_delivered" : "delivered" })
            .where(eq(issueNotes.id, note.id))
            .run();
          if (undelivered) await lane.cancelQueued(note.entryId, BACKGROUND_CONTEXT);
        }
      } finally {
        watch.unsubscribe();
      }
    },
    tools: [
      {
        name: "report_issue",
        label: "Report issue result",
        description: "Report the outcome and evidence for human review.",
        parameters: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["done", "needs_input", "blocked"] },
            summary: { type: "string" },
            evidence: {
              type: "string",
              description: "Checks performed, results, artifacts, and any remaining uncertainty.",
            },
          },
          required: ["state", "summary", "evidence"],
          additionalProperties: false,
        } as never,
        executionMode: "sequential",
        execute: async (_call, params) => {
          const args = params as {
            state?: IssueVerdict;
            summary?: string;
            evidence?: string;
          };
          if (
            !["done", "needs_input", "blocked"].includes(args.state ?? "") ||
            typeof args.summary !== "string" ||
            !args.summary.trim() ||
            typeof args.evidence !== "string"
          )
            throw new Error("A valid state, summary, and evidence are required.");
          const attempt = db
            .select()
            .from(issueAttempts)
            .where(eq(issueAttempts.id, attemptId))
            .get();
          const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
          if (
            !attempt ||
            attempt.issueId !== issueId ||
            attempt.outcome !== "running" ||
            issue?.status !== "in_progress"
          )
            throw new Error("This attempt is no longer active.");
          db.transaction(() => {
            db.update(issueAttempts)
              .set({
                summary: args.summary!.trim().slice(0, 4000),
                evidence: args.evidence!.trim().slice(0, 12000),
              })
              .where(eq(issueAttempts.id, attemptId))
              .run();
            db.update(issues)
              .set({
                verdict: args.state,
                verdictSummary: args.summary!.trim().slice(0, 4000),
                updatedAt: now(),
              })
              .where(eq(issues.id, issueId))
              .run();
          });
          return {
            content: [
              {
                type: "text",
                text: "Report saved. End your turn with a short message for the user.",
              },
            ],
            details: args,
          };
        },
      },
    ],
  };
}

export function finishIssueAttempt(attemptId: string, result: AgentRunResult) {
  const attempt = db.select().from(issueAttempts).where(eq(issueAttempts.id, attemptId)).get();
  if (!attempt || attempt.outcome !== "running") return;
  const issue = db.select().from(issues).where(eq(issues.id, attempt.issueId)).get();
  if (!issue) return;
  db.transaction(() => {
    db.update(issueAttempts)
      .set({
        outcome: result.outcome,
        finishedAt: now(),
        summary:
          result.outcome === "succeeded"
            ? attempt.summary
            : (result.detail ?? "The attempt stopped before completion."),
      })
      .where(eq(issueAttempts.id, attemptId))
      .run();
    const status = closed(issue)
      ? issue.status
      : result.outcome !== "succeeded"
        ? "backlog"
        : issue.verdict === "needs_input"
          ? "needs_input"
          : issue.verdict === "blocked"
            ? "blocked"
            : issue.verdict === "done"
              ? "in_review"
              : "needs_input";
    db.update(issues)
      .set({
        status,
        lastRunOutcome: result.outcome,
        lastRunDetail:
          result.detail ??
          (result.outcome === "succeeded" && !issue.verdict
            ? "The agent ended without delivering a result report. Ask it to continue or report its result."
            : null),
        updatedAt: now(),
      })
      .where(eq(issues.id, issue.id))
      .run();
    addEvent(
      issue.id,
      `Attempt ${result.outcome}: ${result.detail ?? attempt.summary ?? "No result report was provided."}`,
      "result",
    );
    db.update(issueNotes)
      .set({ delivery: "not_delivered" })
      .where(and(eq(issueNotes.issueId, issue.id), eq(issueNotes.delivery, "queued")))
      .run();
  });
  wakeQueue(issue.agentId);
}

export function updateIssue(
  userId: string,
  agentId: string,
  issueId: string,
  patch: IssuePatchCommand,
): IssueDetail {
  const current = readIssue(userId, agentId, issueId);
  requireIdle(current);
  if (closed(current)) throw new IssueError("Reopen the issue before editing its brief.", 409);
  if (current.status === "queued")
    throw new IssueError("Remove this issue from the queue before editing its brief.", 409);
  if (patch.status && !["backlog", "todo"].includes(current.status))
    throw new IssueError("Only unstarted issues can move between Backlog and To do.", 409);
  db.transaction(() => {
    db.update(issues)
      .set({
        ...patch,
        status: current.status === "in_review" ? "todo" : (patch.status ?? current.status),
        updatedAt: now(),
      })
      .where(eq(issues.id, issueId))
      .run();
    addEvent(issueId, "Brief updated. Changes apply to the next attempt.");
  });
  return readIssueView(userId, agentId, issueId);
}
export function acceptIssue(userId: string, agentId: string, issueId: string): IssueDetail {
  const current = readIssue(userId, agentId, issueId);
  requireIdle(current);
  if (current.status !== "in_review")
    throw new IssueError("Only work awaiting review can be accepted.", 409);
  db.update(issues)
    .set({ status: "done", closedAt: now(), updatedAt: now() })
    .where(eq(issues.id, issueId))
    .run();
  addEvent(issueId, "Accepted the result and marked Done.");
  return readIssueView(userId, agentId, issueId);
}
export function reopenIssue(userId: string, agentId: string, issueId: string): IssueDetail {
  const current = readIssue(userId, agentId, issueId);
  requireIdle(current);
  if (!closed(current)) throw new IssueError("This issue is already open.", 409);
  db.update(issues)
    .set({ status: "backlog", closedAt: null, updatedAt: now() })
    .where(eq(issues.id, issueId))
    .run();
  addEvent(issueId, "Reopened. No run started.");
  return readIssueView(userId, agentId, issueId);
}
export function interruptIssue(userId: string, agentId: string, issueId: string): IssueDetail {
  const issue = readIssue(userId, agentId, issueId);
  if (issue.status === "queued") return removeIssueFromQueue(userId, agentId, issueId);
  const attempt = activeAttempt(issueId);
  const run = attempt?.sessionId ? getActiveAgentRunForSessionId(attempt.sessionId) : undefined;
  if (run) abortAgentRun(userId, run.runId);
  else if (attempt && !settling.has(attempt.id))
    finishIssueAttempt(attempt.id, {
      outcome: "interrupted",
      detail: "Stopped before the run started.",
    });
  addEvent(issue.id, "Stop requested.");
  return readIssueView(userId, agentId, issueId);
}
export function cancelIssue(userId: string, agentId: string, issueId: string): IssueDetail {
  readIssue(userId, agentId, issueId);
  db.update(issues)
    .set({
      status: "cancelled",
      queuePosition: null,
      queuedCommand: null,
      closedAt: now(),
      updatedAt: now(),
    })
    .where(eq(issues.id, issueId))
    .run();
  interruptIssue(userId, agentId, issueId);
  addEvent(issueId, "Cancelled issue.");
  return readIssueView(userId, agentId, issueId);
}
export async function deleteIssue(userId: string, agentId: string, issueId: string) {
  requireIdle(readIssue(userId, agentId, issueId));
  const rows = db.select().from(sessions).where(eq(sessions.issueId, issueId)).all();
  db.transaction(() => {
    db.delete(issues).where(eq(issues.id, issueId)).run();
    db.delete(sessions).where(eq(sessions.issueId, issueId)).run();
  });
  for (const session of rows) await deletePiSession(session);
}
export function deleteIssuesForAgent(agentId: string) {
  db.delete(issues).where(eq(issues.agentId, agentId)).run();
}
export function recoverIssueAttempts() {
  for (const attempt of db
    .select()
    .from(issueAttempts)
    .where(eq(issueAttempts.outcome, "running"))
    .all()) {
    finishIssueAttempt(attempt.id, {
      outcome: "interrupted",
      detail:
        "The server restarted before this attempt finished. Queue this issue to continue the conversation.",
    });
  }
}
function activeAttempt(issueId: string) {
  return db
    .select()
    .from(issueAttempts)
    .where(and(eq(issueAttempts.issueId, issueId), eq(issueAttempts.outcome, "running")))
    .get();
}
function requireIdle(issue: IssueRecord) {
  if (activeAttempt(issue.id))
    throw new IssueError("The agent is still working. Stop it before changing this issue.", 409);
}
function closed(issue: IssueRecord) {
  return issue.status === "done" || issue.status === "cancelled";
}
function assertAgentVisible(userId: string, agentId: string) {
  const agent = readVisibleAgent(userId, agentId);
  if (!agent) throw new IssueError("Agent not found.", 404);
  return agent;
}
function addEvent(issueId: string, body: string, kind: "note" | "action" | "result" = "action") {
  const noteId = id("note");
  db.insert(issueNotes).values({ id: noteId, issueId, kind, body, createdAt: now() }).run();
  return noteId;
}
function issuePrompt(issue: IssueRecord) {
  const notes = db
    .select()
    .from(issueNotes)
    .where(eq(issueNotes.issueId, issue.id))
    .orderBy(desc(issueNotes.createdAt))
    .limit(100)
    .all()
    .reverse();
  const attempts = db
    .select()
    .from(issueAttempts)
    .where(eq(issueAttempts.issueId, issue.id))
    .orderBy(desc(issueAttempts.createdAt))
    .limit(10)
    .all()
    .reverse();
  return `# ${issue.title}\n\n${issue.description}\n\n## Acceptance criteria\n${issue.criteria.map((c) => `- ${c}`).join("\n") || "No additional criteria."}\n\n## Recent activity\n${notes.map((n) => n.body).join("\n\n")}\n\n## Previous attempts\n${attempts.map((a) => `${a.outcome}: ${a.summary ?? "No report"}\n${a.evidence ?? ""}`).join("\n\n")}`;
}
function serializeIssue(row: IssueRecord): Issue {
  const { queuedCommand, queuePosition, ...fields } = row;
  return {
    ...fields,
    queuePosition: queuePosition ?? undefined,
    queuedInstructions: queuedCommand?.instructions,
    sessionId: row.sessionId || undefined,
    running: Boolean(activeAttempt(row.id)),
    lastRunOutcome: row.lastRunOutcome ?? undefined,
    lastRunDetail: row.lastRunDetail ?? undefined,
    verdict: row.verdict ?? undefined,
    verdictSummary: row.verdictSummary ?? undefined,
    closedAt: row.closedAt ?? undefined,
  };
}
