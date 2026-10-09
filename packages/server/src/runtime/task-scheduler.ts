import type { AgentTaskOutcome } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { errorMessage } from "../errors.ts";
import { computeNextRun, planTaskFiring } from "../effectors/task-schedule.ts";
import {
  markInterruptedTaskRuns,
  finishTaskRun,
  readDueTasks,
  recordTaskRun,
  scheduleOf,
  startTaskRun,
  updateTaskAfterRun,
} from "../services/agent-tasks.ts";
import { readTaskAgent } from "../services/agent-access.ts";
import { prepareSessionRun } from "../services/session-launch.ts";
import { startDetachedAgentRun, whenRunFinished, type AgentRunInput } from "./agent-runtime.ts";

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
 * recovery, and the failure classifier without any of it being
 * reimplemented here. Unattended runs are exactly where the guard matters most.
 */

const POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 2;

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;
const running = new Set<string>();

export function startTaskScheduler() {
  if (timer) return;
  markInterruptedTaskRuns();
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
}

export function stopTaskScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

/** Exported for tests. */
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
          updateTaskAfterRun(task.id, {
            nextRunAt: null,
            status: "completed",
            outcome: task.lastOutcome ?? "succeeded",
          });
          break;
        case "disable":
          // The schedule cannot be parsed any more, so the next tick would
          // reach the same conclusion. Stop asking.
          recordTaskRun({
            taskId: task.id,
            scheduledFor: task.nextRunAt ?? at,
            startedAt: at,
            outcome: "failed",
            detail: plan.reason,
          });
          updateTaskAfterRun(task.id, {
            nextRunAt: null,
            status: "disabled",
            outcome: "failed",
            error: plan.reason,
          });
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
 * next runs on its own. Answers once the run has started rather than when it
 * ends, so the caller can open the run's session and watch it.
 */
export async function runTaskNow(
  task: TaskRecord,
): Promise<TaskResult | { outcome: "running"; sessionId: string }> {
  if (running.has(task.id)) return { outcome: "skipped", detail: "This task is already running." };
  running.add(task.id);
  const firing = await startTask(task, now()).catch((error: unknown) => {
    running.delete(task.id);
    throw error;
  });
  void firing.finished.finally(() => running.delete(task.id));
  return firing.sessionId ? { outcome: "running", sessionId: firing.sessionId } : firing.finished;
}

async function fireTask(task: TaskRecord, scheduledFor: number) {
  const { outcome, detail } = await (await startTask(task, scheduledFor)).finished;
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

type TaskResult = { outcome: AgentTaskOutcome; detail?: string };

/**
 * Start one run of a task in a session of its own.
 *
 * Resolves as soon as the run is under way, or known not to run at all;
 * `finished` settles with the outcome once the run log has recorded it.
 */
async function startTask(
  task: TaskRecord,
  scheduledFor: number,
): Promise<{ sessionId?: string; finished: Promise<TaskResult> }> {
  const startedAt = now();
  const prepared = await prepareTaskRun(task).catch((error: unknown) => ({
    error: errorMessage(error),
  }));
  if ("error" in prepared) {
    const result: TaskResult = { outcome: "failed", detail: prepared.error };
    recordTaskRun({ taskId: task.id, scheduledFor, startedAt, ...result });
    return { finished: Promise.resolve(result) };
  }

  const sessionId = prepared.input.session.id;
  const runId = startTaskRun({ taskId: task.id, scheduledFor, startedAt, sessionId });
  const finished = (async (): Promise<TaskResult> => {
    try {
      // The run's own verdict: a provider rejection, a guard stop, or a result
      // that could not be saved all end the run normally, so finishing is not
      // the same as succeeding.
      return await whenRunFinished(startDetachedAgentRun(prepared.input));
    } catch (error) {
      return { outcome: "failed", detail: errorMessage(error) };
    }
  })().then((result) => {
    finishTaskRun(runId, result);
    return result;
  });
  return { sessionId, finished };
}

async function prepareTaskRun(
  task: TaskRecord,
): Promise<{ input: AgentRunInput } | { error: string }> {
  // Checked on every firing with the rule that let the task be created, so a
  // task stops once its owner could no longer create it -- an agent un-shared,
  // or an admin demoted.
  const owner = db.select().from(users).where(eq(users.id, task.userId)).get();
  const agent = owner ? readTaskAgent(owner, task.agentId) : undefined;
  if (!agent)
    return { error: "The agent this task belongs to is no longer available to its owner." };

  // Every run gets a fresh session. One thread per task used to be the rule,
  // for the prompt cache -- but the cache lives an hour at most, so a daily task
  // started cold anyway while paying for an ever-longer context. A fresh
  // session also keeps one bad run from steering the next. The task id keeps it
  // out of the session list; the run log links to it.
  const prepared = await prepareSessionRun({
    agent,
    userId: task.userId,
    modelRefId: task.modelRefId ?? undefined,
    thinkingLevel: task.thinkingLevel ?? undefined,
    session: { title: task.name, taskId: task.id },
  });
  if (!prepared.ok)
    return { error: "The model this task uses is no longer available to its owner." };
  return { input: { ...prepared.value, promptInput: { text: task.prompt } } };
}

function maxConcurrent() {
  const configured = Number(process.env.CARMEL_AGENT_MAX_CONCURRENT_TASKS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_CONCURRENT;
}
