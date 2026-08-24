import { eq } from "drizzle-orm";
import { toSessionRow, type AgentTaskOutcome, type Session } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { agents, modelRefs, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { errorMessage } from "../errors.ts";
import { computeNextRun, planTaskFiring } from "../effectors/task-schedule.ts";
import {
  attachTaskSession,
  readDueTasks,
  recordTaskRun,
  scheduleOf,
  updateTaskAfterRun,
} from "../services/agent-tasks.ts";
import { readActiveRunLeaseForSession } from "../services/active-run-lease.ts";
import { resolveSupportedThinkingLevel } from "../services/agent-access.ts";
import { resolveModelContext } from "../services/model-context.ts";

import { startDetachedAgentRun, whenRunFinished } from "./agent-runtime.ts";
import { loadSession } from "../services/session-store.ts";

type TaskRecord = typeof import("../db/schema.ts").agentTasks.$inferSelect;

/**
 * Fires scheduled tasks.
 *
 * A poll loop rather than a timer per task: tasks are edited, paused and deleted
 * from under it, and one query for "active and due" is both simpler and
 * self-correcting after a restart. The same shape piclaw uses.
 *
 * Firing goes through `startDetachedAgentRun`, the same path an interactive run
 * takes, so a scheduled run inherits the run guard, compaction and context
 * recovery, the failure classifier, and extension tools without any of it being
 * reimplemented here. Unattended runs are exactly where the guard matters most.
 */

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 2;

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;
const running = new Set<string>();

export function startTaskScheduler() {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopTaskScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

/** Exported for tests and for the "run now" route, which fires one task by hand. */
export async function tick(at = now()) {
  // Ticks do not overlap. A slow tick would otherwise start a second copy of
  // every task it had not yet reached.
  if (ticking) return;
  ticking = true;
  try {
    const capacity = maxConcurrent() - running.size;
    if (capacity <= 0) return;

    const due = readDueTasks(at);
    const fired: Promise<void>[] = [];
    for (const task of due) {
      if (fired.length >= capacity) break;
      if (running.has(task.id)) continue;
      const plan = planTaskFiring({
        status: task.status === "active" ? "active" : "paused",
        schedule: scheduleOf(task),
        nextRunAt: task.nextRunAt,
        now: at,
      });

      switch (plan.action) {
        case "idle":
          break;
        case "complete":
          updateTaskAfterRun(task.id, { nextRunAt: null, status: "completed", outcome: task.lastOutcome ?? "succeeded" });
          break;
        case "disable":
          // The schedule cannot be parsed any more, so the next tick would
          // reach the same conclusion. Stop asking.
          recordTaskRun({ taskId: task.id, scheduledFor: task.nextRunAt ?? at, startedAt: at, outcome: "failed", detail: plan.reason });
          updateTaskAfterRun(task.id, { nextRunAt: null, status: "disabled", outcome: "failed", error: plan.reason });
          break;
        case "skip_missed":
          recordTaskRun({
            taskId: task.id,
            scheduledFor: plan.scheduledFor,
            startedAt: at,
            outcome: "missed",
            detail: "The server was not running when this was due.",
          });
          updateTaskAfterRun(task.id, { nextRunAt: plan.nextRunAt, outcome: "missed" });
          break;
        case "fire":
          running.add(task.id);
          fired.push(fireTask(task, plan.scheduledFor).finally(() => running.delete(task.id)));
          break;
      }
    }
    await Promise.allSettled(fired);
  } catch (error) {
    // A poll loop that throws stops polling. Nothing here is worth that.
    console.warn("Task scheduler tick failed:", errorMessage(error));
  } finally {
    ticking = false;
  }
}

/**
 * Fire one task immediately, outside the schedule.
 *
 * Does not disturb `nextRunAt`: trying a task by hand should not move when it
 * next runs on its own.
 */
export async function runTaskNow(task: TaskRecord) {
  if (running.has(task.id)) return { outcome: "skipped" as const, detail: "This task is already running." };
  running.add(task.id);
  const startedAt = now();
  try {
    const result = await executeTask(task);
    recordTaskRun({ taskId: task.id, scheduledFor: startedAt, startedAt, outcome: result.outcome, detail: result.detail });
    return result;
  } finally {
    running.delete(task.id);
  }
}

async function fireTask(task: TaskRecord, scheduledFor: number) {
  const startedAt = now();
  const { outcome, detail } = await executeTask(task);
  recordTaskRun({ taskId: task.id, scheduledFor, startedAt, outcome, detail });
  // Re-arm from the later of the occurrence and the completion. From the
  // occurrence alone, a run that outlasts its own interval would come back due
  // the instant it finished; from the clock alone, a one-shot whose instant is
  // still a second away would re-arm instead of completing.
  const next = computeNextRun(scheduleOf(task), Math.max(scheduledFor, now()));
  updateTaskAfterRun(task.id, {
    nextRunAt: next.ok ? next.at : null,
    status: next.ok && next.at === null ? "completed" : undefined,
    outcome,
    error: detail,
  });
}

async function executeTask(task: TaskRecord): Promise<{ outcome: AgentTaskOutcome; detail?: string }> {
  try {
    const prepared = await prepareTaskRun(task);
    if ("error" in prepared) {
      return { outcome: prepared.skipped ? "skipped" : "failed", detail: prepared.error };
    }
    // The run reports its own failures into the session transcript, so reaching
    // the end is the outcome this layer can honestly claim.
    await whenRunFinished(startDetachedAgentRun(prepared.input));
    return { outcome: "succeeded" };
  } catch (error) {
    return { outcome: "failed", detail: errorMessage(error) };
  }
}

type PreparedTaskRun =
  | { input: Parameters<typeof startDetachedAgentRun>[0] }
  | { error: string; skipped?: boolean };

async function prepareTaskRun(task: TaskRecord): Promise<PreparedTaskRun> {
  const agent = db.select().from(agents).where(eq(agents.id, task.agentId)).get();
  if (!agent) return { error: "The agent this task belongs to no longer exists." };

  const session = await ensureTaskSession(task, agent);
  if ("error" in session) return session;

  // A firing must never overlap its own previous one. The session is the
  // task's alone, so an active run on it is either the last firing still going
  // or a person reading it in the UI and prompting -- both mean wait.
  if (readActiveRunLeaseForSession(session.record.id)) {
    return { error: "The previous run of this task was still going.", skipped: true };
  }

  const modelRefId = task.modelRefId ?? session.record.modelRefId;
  const context = await resolveModelContext(task.userId, modelRefId);
  if (!context.ok) {
    return { error: "The model this task uses is no longer available to its owner." };
  }

  return {
    input: {
      agent,
      session: session.record,
      modelRef: context.value.modelRef,
      providerConfig: context.value.providerConfig,
      modelRuntime: context.value.modelRuntime,
      thinkingLevel: task.thinkingLevel ?? session.record.thinkingLevel,
      promptInput: { text: task.prompt },
    },
  };
}

/**
 * The task's own session, created on the first firing.
 *
 * Created lazily so a task that is paused before it ever runs leaves nothing
 * behind, and reused every firing after that: one thread per task means a
 * stable prompt prefix, which is the difference between a daily task hitting
 * the provider cache and paying full price every night.
 */
async function ensureTaskSession(
  task: TaskRecord,
  agent: typeof agents.$inferSelect,
): Promise<{ record: Awaited<ReturnType<typeof loadSession>> & object } | { error: string }> {
  if (task.sessionId) {
    const existing = await loadSession(task.sessionId);
    if (existing) return { record: existing };
    // Deleted from the UI. Making a new one is friendlier than disabling the
    // task, and the run log keeps the history the session lost.
  }

  const modelRefId = task.modelRefId ?? agent.defaultModelRefId;
  const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, modelRefId)).get();
  if (!modelRef) return { error: "The model this task uses no longer exists." };

  const timestamp = now();
  const session: Session = {
    id: id("session"),
    title: task.name,
    userId: task.userId,
    agentId: task.agentId,
    modelRefId,
    thinkingLevel: resolveSupportedThinkingLevel(modelRef, task.thinkingLevel ?? agent.defaultThinkingLevel ?? "off"),
    revision: 0,
    messages: [],
    messageEntryIds: [],
    pinnedAt: undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(sessions).values(toSessionRow(session)).run();
  attachTaskSession(task.id, session.id);

  const created = await loadSession(session.id);
  return created ? { record: created } : { error: "Could not create the task's session." };
}

function maxConcurrent() {
  const configured = Number(process.env.CARMEL_AGENT_MAX_CONCURRENT_TASKS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_CONCURRENT;
}
