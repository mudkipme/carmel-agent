import { and, desc, eq, lte } from "drizzle-orm";
import type { AgentTask, AgentTaskOutcome, AgentTaskRun, UserRole } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { agents, agentTasks, agentTaskRuns, modelRefs, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { computeNextRun, validateSchedule, type TaskSchedule } from "../effectors/task-schedule.ts";
import { readActiveRunLeaseForSession } from "./active-run-lease.ts";
import { canUseModel, readVisibleAgent } from "./agent-access.ts";
import { deletePiSession } from "./pi-session-storage.ts";

type TaskRecord = typeof agentTasks.$inferSelect;

export class AgentTaskError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

/**
 * Tasks live inside an agent, so agent visibility is the outer gate -- but a
 * shared agent is visible to everyone who can use it, and a task carries the
 * prompt someone wrote and drives a session private to them. So the inner gate
 * is ownership: you see your own tasks on agents you can see. Admins see all,
 * because the operator holding the API keys should be able to find what is
 * spending them.
 */
export function readAgentTasks(user: { id: string; role: UserRole }, agentId: string): AgentTask[] {
  assertAgentVisible(user, agentId);
  const rows = db.select().from(agentTasks).where(eq(agentTasks.agentId, agentId)).all();
  return rows.filter((row) => user.role === "admin" || row.userId === user.id).map(serializeTask);
}

/**
 * Admins bypass agent visibility as well as task ownership.
 *
 * "Admins see all" is only true if it clears both gates -- checking agent
 * visibility first would hide every task on an agent the admin does not own,
 * which is most of them. This is not a new exposure: carmel admins already
 * manage every user and hold the provider credentials.
 */
function assertAgentVisible(user: { id: string; role: UserRole }, agentId: string) {
  if (user.role === "admin") {
    if (!db.select().from(agents).where(eq(agents.id, agentId)).get()) {
      throw new AgentTaskError("Agent not found.", 404);
    }
    return;
  }
  if (!readVisibleAgent(user.id, agentId)) throw new AgentTaskError("Agent not found.", 404);
}

export function readAgentTask(user: { id: string; role: UserRole }, agentId: string, taskId: string): TaskRecord {
  assertAgentVisible(user, agentId);
  const row = db.select().from(agentTasks).where(eq(agentTasks.id, taskId)).get();
  // A task on another agent is "not found" rather than "wrong agent": the id
  // alone should not confirm that a task exists somewhere else.
  if (!row || row.agentId !== agentId) throw new AgentTaskError("Task not found.", 404);
  if (user.role !== "admin" && row.userId !== user.id) throw new AgentTaskError("Task not found.", 404);
  return row;
}

export type AgentTaskDraft = {
  name: string;
  prompt: string;
  modelRefId?: string;
  thinkingLevel?: AgentTask["thinkingLevel"];
  scheduleKind: AgentTask["scheduleKind"];
  scheduleValue: string;
  timezone?: string;
  status?: "active" | "paused";
};

export function createAgentTask(user: { id: string; role: UserRole }, agentId: string, draft: AgentTaskDraft): AgentTask {
  assertAgentVisible(user, agentId);
  assertUsableModel(user.id, draft.modelRefId);

  const timestamp = now();
  const schedule = scheduleOf(draft);
  // Validated at write time so a bad expression is a 400 the author sees, not a
  // task that quietly disables itself the first time it comes due.
  const valid = validateSchedule(schedule, timestamp);
  if (!valid.ok) throw new AgentTaskError(valid.reason, 400);

  const status = draft.status ?? "active";
  const next = computeNextRun(schedule, timestamp);
  const row: TaskRecord = {
    id: id("agent_task"),
    agentId,
    userId: user.id,
    name: draft.name,
    prompt: draft.prompt,
    modelRefId: draft.modelRefId ?? null,
    thinkingLevel: draft.thinkingLevel ?? null,
    scheduleKind: draft.scheduleKind,
    scheduleValue: draft.scheduleValue,
    timezone: draft.timezone ?? null,
    status,
    nextRunAt: next.ok ? next.at : null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(agentTasks).values(row).run();
  return serializeTask(row);
}

export function updateAgentTask(
  user: { id: string; role: UserRole },
  agentId: string,
  taskId: string,
  patch: Partial<AgentTaskDraft>,
): AgentTask {
  const current = readAgentTask(user, agentId, taskId);
  if (patch.modelRefId !== undefined) assertUsableModel(current.userId, patch.modelRefId);

  const timestamp = now();
  const merged = { ...current, ...definedOnly(patch) };
  const schedule = scheduleOf(merged);
  const scheduleChanged =
    merged.scheduleKind !== current.scheduleKind ||
    merged.scheduleValue !== current.scheduleValue ||
    (merged.timezone ?? null) !== (current.timezone ?? null);

  if (scheduleChanged) {
    const valid = validateSchedule(schedule, timestamp);
    if (!valid.ok) throw new AgentTaskError(valid.reason, 400);
  }

  // Re-arm when the schedule changed, and when a paused task is resumed: its
  // stored `nextRunAt` is stale by however long it was paused, and firing on
  // resume is not what pausing means.
  const resumed = patch.status === "active" && current.status !== "active";
  const nextRunAt =
    scheduleChanged || resumed ? valueOrNull(computeNextRun(schedule, timestamp)) : current.nextRunAt;

  const row: TaskRecord = {
    ...current,
    name: merged.name,
    prompt: merged.prompt,
    modelRefId: merged.modelRefId ?? null,
    thinkingLevel: merged.thinkingLevel ?? null,
    scheduleKind: merged.scheduleKind,
    scheduleValue: merged.scheduleValue,
    timezone: merged.timezone ?? null,
    status: patch.status ?? current.status,
    nextRunAt,
    updatedAt: timestamp,
  };
  db.update(agentTasks).set(row).where(eq(agentTasks.id, taskId)).run();
  return serializeTask(row);
}

/**
 * Run sessions are only reachable from the task's run history, so they go with
 * the task -- except the ones moved to the session list, which are ordinary
 * sessions by then and no longer carry the task's id.
 */
export async function deleteAgentTask(user: { id: string; role: UserRole }, agentId: string, taskId: string) {
  const task = readAgentTask(user, agentId, taskId);
  const runSessions = db.select().from(sessions).where(eq(sessions.taskId, task.id)).all();
  if (runSessions.some((session) => readActiveRunLeaseForSession(session.id))) {
    throw new AgentTaskError("This task has a run in progress. Try again once it finishes.", 409);
  }
  deleteTaskRows([task.id]);
  for (const session of runSessions) {
    await deletePiSession(session);
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
  }
}

/** Called from agent deletion, which has already checked ownership and deletes the agent's sessions itself. */
export function deleteAgentTasksForAgent(agentId: string) {
  const ids = db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.agentId, agentId)).all();
  deleteTaskRows(ids.map((row) => row.id));
}

function deleteTaskRows(taskIds: string[]) {
  for (const taskId of taskIds) {
    db.delete(agentTaskRuns).where(eq(agentTaskRuns.taskId, taskId)).run();
    db.delete(agentTasks).where(eq(agentTasks.id, taskId)).run();
  }
}

export function readTaskRuns(user: { id: string; role: UserRole }, agentId: string, taskId: string, limit = 50): AgentTaskRun[] {
  readAgentTask(user, agentId, taskId);
  return db
    .select()
    .from(agentTaskRuns)
    .where(eq(agentTaskRuns.taskId, taskId))
    .orderBy(desc(agentTaskRuns.startedAt))
    .limit(limit)
    .all()
    .map(serializeRun);
}

/**
 * The scheduler's query: active tasks whose time has come, most overdue first.
 *
 * Ordered because the tick has a concurrency cap. In table order, a task that
 * is always due -- one whose schedule is stuck, or that keeps failing -- would
 * hold a slot every tick and starve the ones behind it.
 */
export function readDueTasks(at: number): TaskRecord[] {
  return db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.status, "active"), lte(agentTasks.nextRunAt, at)))
    .orderBy(agentTasks.nextRunAt)
    .all();
}

/** Log a firing that never ran: missed, skipped, or failed before it had a session. */
export function recordTaskRun(input: {
  taskId: string;
  scheduledFor: number;
  startedAt: number;
  outcome: AgentTaskOutcome;
  detail?: string;
}) {
  db.insert(agentTaskRuns)
    .values({
      id: id("agent_task_run"),
      taskId: input.taskId,
      scheduledFor: input.scheduledFor,
      startedAt: input.startedAt,
      finishedAt: now(),
      outcome: input.outcome,
      detail: input.detail ?? null,
      sessionId: null,
    })
    .run();
}

/**
 * Log a run as it starts, linked to its session, so the run history can open a
 * run that is still going. `finishTaskRun` records how it ended.
 */
export function startTaskRun(input: { taskId: string; scheduledFor: number; startedAt: number; sessionId: string }) {
  const runId = id("agent_task_run");
  db.insert(agentTaskRuns)
    .values({ id: runId, ...input, finishedAt: null, outcome: "running", detail: null })
    .run();
  return runId;
}

export function finishTaskRun(runId: string, result: { outcome: AgentTaskOutcome; detail?: string }) {
  db.update(agentTaskRuns)
    .set({ finishedAt: now(), outcome: result.outcome, detail: result.detail ?? null })
    .where(eq(agentTaskRuns.id, runId))
    .run();
}

/**
 * A run still marked running when the scheduler starts was cut off by the
 * process stopping. Nothing will ever finish it, so say so.
 */
export function failInterruptedTaskRuns() {
  db.update(agentTaskRuns)
    .set({ finishedAt: now(), outcome: "failed", detail: "The server stopped before this run finished." })
    .where(eq(agentTaskRuns.outcome, "running"))
    .run();
}

export function updateTaskAfterRun(
  taskId: string,
  patch: { nextRunAt: number | null; status?: TaskRecord["status"]; outcome: AgentTaskOutcome; error?: string | null },
) {
  db.update(agentTasks)
    .set({
      nextRunAt: patch.nextRunAt,
      ...(patch.status ? { status: patch.status } : {}),
      lastRunAt: now(),
      lastOutcome: patch.outcome,
      lastError: patch.error ?? null,
      updatedAt: now(),
    })
    .where(eq(agentTasks.id, taskId))
    .run();
}

export function scheduleOf(task: {
  scheduleKind: AgentTask["scheduleKind"];
  scheduleValue: string;
  timezone?: string | null;
}): TaskSchedule {
  return { kind: task.scheduleKind, value: task.scheduleValue, timezone: task.timezone ?? null };
}

function assertUsableModel(userId: string, modelRefId: string | undefined) {
  if (!modelRefId) return;
  const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, modelRefId)).get();
  if (!modelRef || !canUseModel(userId, modelRef)) throw new AgentTaskError("Model not found.", 404);
}

function valueOrNull(next: ReturnType<typeof computeNextRun>) {
  return next.ok ? next.at : null;
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function serializeTask(row: TaskRecord): AgentTask {
  return {
    id: row.id,
    agentId: row.agentId,
    userId: row.userId,
    name: row.name,
    prompt: row.prompt,
    modelRefId: row.modelRefId ?? undefined,
    thinkingLevel: row.thinkingLevel ?? undefined,
    scheduleKind: row.scheduleKind,
    scheduleValue: row.scheduleValue,
    timezone: row.timezone ?? undefined,
    status: row.status,
    nextRunAt: row.nextRunAt ?? undefined,
    lastRunAt: row.lastRunAt ?? undefined,
    lastOutcome: row.lastOutcome ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeRun(row: typeof agentTaskRuns.$inferSelect): AgentTaskRun {
  return {
    id: row.id,
    taskId: row.taskId,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    outcome: row.outcome,
    detail: row.detail ?? undefined,
    sessionId: row.sessionId ?? undefined,
  };
}
