import { and, count, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { ActivityFilter, ActivityKind, ActivityPage, AgentRunResult } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { activity, agents, agentTaskRuns, agentTasks, issues, issueAttempts, sessions } from "../db/schema.ts";

const attentionKinds: ActivityKind[] = ["needs_input", "blocked", "failed", "review", "interrupted", "missed"];

// Every read rechecks agent visibility. A shared agent never shares its users' inboxes.
function visibleTo(userId: string) {
  return and(eq(activity.userId, userId), or(eq(agents.ownerUserId, userId), eq(agents.shared, true)));
}

export function readActivity(userId: string, filter: ActivityFilter = "unread", before?: number): ActivityPage {
  const rows = db.select({ event: activity, agentName: agents.name })
    .from(activity).innerJoin(agents, eq(activity.agentId, agents.id))
    .where(and(visibleTo(userId), before ? lt(activity.id, before) : undefined,
      filter === "unread" ? isNull(activity.readAt) : filter === "attention" ? and(isNull(activity.readAt), inArray(activity.kind, attentionKinds)) : undefined))
    .orderBy(desc(activity.id)).limit(51).all();
  const items = rows.slice(0, 50).map(({ event: { eventKey: _eventKey, userId: _userId, ...event }, agentName }) => ({ ...event, agentName }));
  return { items, unreadCount: unreadActivityCount(userId), nextCursor: rows.length > 50 ? items.at(-1)!.id : null };
}

export function unreadActivityCount(userId: string) {
  return db.select({ count: count() }).from(activity).innerJoin(agents, eq(activity.agentId, agents.id))
    .where(and(visibleTo(userId), isNull(activity.readAt))).get()!.count;
}

export function setActivityRead(userId: string, ids: number[], read: boolean) {
  const visibleIds = db.select({ id: activity.id }).from(activity).innerJoin(agents, eq(activity.agentId, agents.id))
    .where(and(visibleTo(userId), inArray(activity.id, ids))).all().map((row) => row.id);
  if (visibleIds.length) db.update(activity).set({ readAt: read ? Date.now() : null }).where(inArray(activity.id, visibleIds)).run();
}

/** A new attempt or a closed issue supersedes its previous requests for attention. */
export function acknowledgeIssueActivity(issueId: string) {
  db.update(activity).set({ readAt: Date.now() }).where(and(eq(activity.issueId, issueId), isNull(activity.readAt))).run();
}

/** Called after persistence and issue finish listeners, even with no browser attached. */
export function recordSessionActivity(sessionId: string, runId: string, result: AgentRunResult) {
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session || session.taskId || session.issueId || result.outcome === "cancelled") return;
  const kind: ActivityKind = result.outcome === "failed" ? "failed" : result.outcome === "interrupted" ? "interrupted" : "completed";
  writeActivity({ eventKey: `run:${runId}`, userId: session.userId, agentId: session.agentId,
    sessionId, title: session.title, kind,
    summary: result.detail ?? "A new reply is ready. Open the conversation to pick up where you left off." });
}

/** Includes failures before a session exists, missed schedules, and restart recovery. */
export function recordTaskActivity(runId: string) {
  const run = db.select().from(agentTaskRuns).where(eq(agentTaskRuns.id, runId)).get();
  if (!run || run.outcome === "running" || run.outcome === "cancelled" || run.outcome === "skipped") return;
  const task = db.select().from(agentTasks).where(eq(agentTasks.id, run.taskId)).get();
  if (!task) return;
  const kind: ActivityKind = run.outcome === "succeeded" ? "completed" : run.outcome;
  writeActivity({ eventKey: `task-run:${runId}`, userId: task.userId, agentId: task.agentId,
    sessionId: run.sessionId, taskId: task.id, title: task.name, kind,
    summary: run.detail ?? "The scheduled run finished. Open its conversation to review the result." });
}

function writeActivity(input: Omit<typeof activity.$inferInsert, "id" | "createdAt" | "readAt">) {
  db.insert(activity).values({ ...input, summary: input.summary.slice(0, 4_000), createdAt: Date.now() })
    .onConflictDoNothing({ target: activity.eventKey }).run();
}

export function recordIssueActivity(issueId: string, attemptId: string) {
  const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
  const attempt = db.select().from(issueAttempts).where(eq(issueAttempts.id, attemptId)).get();
  if (!issue || !attempt || issue.status === "cancelled" || issue.status === "done" || attempt.outcome === "running") return;
  const kind: ActivityKind = attempt.outcome === "failed" ? "failed" : attempt.outcome !== "succeeded" ? "interrupted"
    : issue.status === "needs_input" ? "needs_input" : issue.status === "blocked" ? "blocked" : "review";
  writeActivity({ eventKey: `issue-attempt:${attemptId}`, userId: issue.userId, agentId: issue.agentId,
    sessionId: attempt.sessionId, issueId, title: issue.title, kind,
    summary: attempt.summary ?? "The attempt finished without a report. Review its conversation before accepting." });
}
