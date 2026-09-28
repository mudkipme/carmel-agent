import { and, asc, desc, eq } from "drizzle-orm";
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
import { startDetachedAgentRun, type SessionRunAddons } from "../runtime/agent-runtime.ts";
import { abortAgentRun, getActiveAgentRunForSessionId, onRunFinished } from "../runtime/run-stream.ts";
import { readVisibleAgent } from "./agent-access.ts";
import { NO_PROVIDER_AUTH_MESSAGE, resolveRunModel } from "./model-context.ts";
import { deletePiSession } from "./pi-session-storage.ts";
import { insertSession } from "./session-launch.ts";
import { acknowledgeIssueActivity, recordIssueActivity } from "./activity.ts";

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
  if (!row || row.agentId !== agentId || row.userId !== userId) throw new IssueError("Issue not found.", 404);
  return row;
}
export function readIssueView(userId: string, agentId: string, issueId: string): IssueDetail {
  return {
    ...serializeIssue(readIssue(userId, agentId, issueId)),
    attempts: db
      .select()
      .from(issueAttempts)
      .where(eq(issueAttempts.issueId, issueId))
      .orderBy(desc(issueAttempts.createdAt))
      .all(),
    notes: db.select().from(issueNotes).where(eq(issueNotes.issueId, issueId)).orderBy(asc(issueNotes.createdAt)).all(),
  };
}
export function createIssue(userId: string, agentId: string, draft: IssueCreateCommand): IssueDetail {
  assertAgentVisible(userId, agentId);
  const issueId = id("issue");
  // Legacy session_id is NOT NULL. Empty means no attempt yet; public API omits it.
  db.insert(issues)
    .values({
      ...draft,
      id: issueId,
      agentId,
      userId,
      sessionId: "",
      status: draft.status ?? "todo",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  addEvent(issueId, "Issue created. No run started.");
  return readIssueView(userId, agentId, issueId);
}
export function addIssueNote(userId: string, agentId: string, issueId: string, body: string): IssueDetail {
  readIssue(userId, agentId, issueId);
  addEvent(issueId, body, "note");
  db.update(issues).set({ updatedAt: now() }).where(eq(issues.id, issueId)).run();
  return readIssueView(userId, agentId, issueId);
}

/** Claim synchronously before resolving credentials; a second click cannot start another attempt. */
export async function runIssue(
  userId: string,
  agentId: string,
  issueId: string,
  command: IssueRunCommand,
): Promise<IssueDetail> {
  const current = readIssue(userId, agentId, issueId);
  requireIdle(current);
  if (closed(current)) throw new IssueError("Reopen the issue before starting another run.", 409);
  if (["in_review", "needs_input"].includes(current.status) && !command.instructions?.trim()) {
    throw new IssueError("Provide feedback or an answer before starting another run.", 400);
  }
  const agent = assertAgentVisible(userId, agentId);
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
        verdict: null,
        verdictSummary: null,
        lastRunOutcome: null,
        lastRunDetail: null,
        updatedAt: now(),
      })
      .where(eq(issues.id, issueId))
      .run();
    addEvent(issueId, command.instructions ? `Sent to agent:\n${command.instructions}` : "Started work.");
    acknowledgeIssueActivity(issueId);
  });
  try {
    const model = await resolveRunModel(
      userId,
      command.modelRefId ?? agent.defaultModelRefId,
      command.thinkingLevel ?? agent.defaultThinkingLevel ?? "off",
    );
    // A pause, cancellation, or deletion during credential resolution invalidates this claim.
    const attempt = db.select().from(issueAttempts).where(eq(issueAttempts.id, attemptId)).get();
    if (!attempt || attempt.outcome !== "running")
      throw new IssueError("This attempt was stopped before it started.", 409);
    readIssue(userId, agentId, issueId);
    const currentAgent = assertAgentVisible(userId, agentId);
    if (!model.ok)
      throw new IssueError(model.reason === "not_found" ? "Model not found." : NO_PROVIDER_AUTH_MESSAGE, 400);
    const { modelRef, providerConfig, modelRuntime, thinkingLevel } = model.value;
    const session = insertSession({
      userId,
      agentId,
      modelRefId: modelRef.id,
      thinkingLevel,
      issueId,
      title: current.title,
    });
    db.update(issueAttempts).set({ sessionId: session.id }).where(eq(issueAttempts.id, attemptId)).run();
    db.update(issues).set({ sessionId: session.id }).where(eq(issues.id, issueId)).run();
    const run = startDetachedAgentRun({
      agent: currentAgent,
      session,
      modelRef,
      providerConfig,
      modelRuntime,
      thinkingLevel,
      promptInput: {
        text: `${brief}\n\n## Instructions for this attempt\n${command.instructions || "Carry out the brief."}`,
      },
      sessionAddons: issueRunAddons(issueId, attemptId),
    });
    onRunFinished(run, (result) => finishIssueAttempt(attemptId, result));
  } catch (error) {
    finishIssueAttempt(attemptId, {
      outcome: "failed",
      detail: errorMessage(error),
    });
    throw error;
  }
  return readIssueView(userId, agentId, issueId);
}

export function issueRunAddons(issueId: string, attemptId: string): SessionRunAddons {
  return {
    instructions: `You are executing one attempt on a durable issue in this agent's workspace. The brief and acceptance criteria are the contract. Prior attempts share files, but not conversation context. Inspect existing work before changing it. When you stop, call report_issue as your final action. Use done when ready for human review, needs_input with specific questions, or blocked with the obstacle. Include concrete verification evidence, and distinguish checked results from assumptions. Reporting done never closes the issue; only the user accepts it.`,
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
          const attempt = db.select().from(issueAttempts).where(eq(issueAttempts.id, attemptId)).get();
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
        ? "blocked"
        : issue.verdict === "needs_input"
          ? "needs_input"
          : issue.verdict === "blocked"
            ? "blocked"
            : "in_review";
    db.update(issues)
      .set({
        status,
        lastRunOutcome: result.outcome,
        lastRunDetail: result.detail ?? null,
        updatedAt: now(),
      })
      .where(eq(issues.id, issue.id))
      .run();
    addEvent(
      issue.id,
      `Attempt ${result.outcome}: ${result.detail ?? attempt.summary ?? "No result report was provided."}`,
      "result",
    );
    recordIssueActivity(issue.id, attemptId);
  });
}

export function updateIssue(userId: string, agentId: string, issueId: string, patch: IssuePatchCommand): IssueDetail {
  const current = readIssue(userId, agentId, issueId);
  requireIdle(current);
  if (closed(current)) throw new IssueError("Reopen the issue before editing its brief.", 409);
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
  if (current.status !== "in_review") throw new IssueError("Only work awaiting review can be accepted.", 409);
  db.update(issues).set({ status: "done", closedAt: now(), updatedAt: now() }).where(eq(issues.id, issueId)).run();
  addEvent(issueId, "Accepted the result and marked Done.");
  acknowledgeIssueActivity(issueId);
  return readIssueView(userId, agentId, issueId);
}
export function reopenIssue(userId: string, agentId: string, issueId: string): IssueDetail {
  const current = readIssue(userId, agentId, issueId);
  requireIdle(current);
  if (!closed(current)) throw new IssueError("This issue is already open.", 409);
  db.update(issues).set({ status: "todo", closedAt: null, updatedAt: now() }).where(eq(issues.id, issueId)).run();
  addEvent(issueId, "Reopened. No run started.");
  return readIssueView(userId, agentId, issueId);
}
export function interruptIssue(userId: string, agentId: string, issueId: string): IssueDetail {
  const issue = readIssue(userId, agentId, issueId);
  const attempt = activeAttempt(issueId);
  const run = attempt?.sessionId ? getActiveAgentRunForSessionId(attempt.sessionId) : undefined;
  if (run) abortAgentRun(userId, run.runId);
  else if (attempt)
    finishIssueAttempt(attempt.id, {
      outcome: "interrupted",
      detail: "Paused before the run started.",
    });
  addEvent(issue.id, "Pause requested.");
  return readIssueView(userId, agentId, issueId);
}
export function cancelIssue(userId: string, agentId: string, issueId: string): IssueDetail {
  readIssue(userId, agentId, issueId);
  db.update(issues).set({ status: "cancelled", closedAt: now(), updatedAt: now() }).where(eq(issues.id, issueId)).run();
  interruptIssue(userId, agentId, issueId);
  addEvent(issueId, "Cancelled issue.");
  acknowledgeIssueActivity(issueId);
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
  for (const attempt of db.select().from(issueAttempts).where(eq(issueAttempts.outcome, "running")).all()) {
    finishIssueAttempt(attempt.id, {
      outcome: "interrupted",
      detail: "The server restarted before this attempt finished. Start a new attempt to continue.",
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
    throw new IssueError("The agent is still working. Pause it before changing this issue.", 409);
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
  db.insert(issueNotes)
    .values({ id: id("note"), issueId, kind, body, createdAt: now() })
    .run();
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
  return {
    ...row,
    sessionId: row.sessionId || undefined,
    running: Boolean(activeAttempt(row.id)),
    lastRunOutcome: row.lastRunOutcome ?? undefined,
    lastRunDetail: row.lastRunDetail ?? undefined,
    verdict: row.verdict ?? undefined,
    verdictSummary: row.verdictSummary ?? undefined,
    closedAt: row.closedAt ?? undefined,
  };
}
