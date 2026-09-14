import { eq } from "drizzle-orm";
import { toSessionRow, type AgentTaskOutcome, type Session } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { agents, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { errorMessage } from "../errors.ts";
import { computeNextRun, planTaskFiring } from "../effectors/task-schedule.ts";
import {
  failInterruptedTaskRuns,
  finishTaskRun,
  readDueTasks,
  recordTaskRun,
  scheduleOf,
  startTaskRun,
  updateTaskAfterRun,
} from "../services/agent-tasks.ts";
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
  failInterruptedTaskRuns();
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
 * next runs on its own. Answers once the run has started rather than when it
 * ends, so the caller can open the run's session and watch it.
 */
export async function runTaskNow(task: TaskRecord): Promise<TaskResult | { outcome: "running"; sessionId: string }> {
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
  const prepared = await prepareTaskRun(task).catch((error: unknown) => ({ error: errorMessage(error) }));
  if ("error" in prepared) {
    const result: TaskResult = { outcome: "failed", detail: prepared.error };
    recordTaskRun({ taskId: task.id, scheduledFor, startedAt, ...result });
    return { finished: Promise.resolve(result) };
  }

  const sessionId = prepared.input.session.id;
  const runId = startTaskRun({ taskId: task.id, scheduledFor, startedAt, sessionId });
  const finished = (async (): Promise<TaskResult> => {
    try {
      // The run reports its own failures into the session transcript, so
      // reaching the end is the outcome this layer can honestly claim.
      await whenRunFinished(startDetachedAgentRun(prepared.input));
      return { outcome: "succeeded" };
    } catch (error) {
      return { outcome: "failed", detail: errorMessage(error) };
    }
  })().then((result) => {
    finishTaskRun(runId, result);
    return result;
  });
  return { sessionId, finished };
}

async function prepareTaskRun(task: TaskRecord): Promise<{ input: Parameters<typeof startDetachedAgentRun>[0] } | { error: string }> {
  const agent = db.select().from(agents).where(eq(agents.id, task.agentId)).get();
  if (!agent) return { error: "The agent this task belongs to no longer exists." };

  // Resolved before the session exists: a task that cannot run must not leave
  // an empty session behind every time it fires.
  const context = await resolveModelContext(task.userId, task.modelRefId ?? agent.defaultModelRefId);
  if (!context.ok) {
    return { error: "The model this task uses is no longer available to its owner." };
  }
  const { modelRef } = context.value;
  const thinkingLevel = resolveSupportedThinkingLevel(modelRef, task.thinkingLevel ?? agent.defaultThinkingLevel ?? "off");

  const session = await createRunSession(task, modelRef.id, thinkingLevel);
  if (!session) return { error: "Could not create a session for this run." };

  return {
    input: {
      agent,
      session,
      modelRef,
      providerConfig: context.value.providerConfig,
      modelRuntime: context.value.modelRuntime,
      thinkingLevel,
      promptInput: { text: task.prompt },
    },
  };
}

/**
 * Every run gets a fresh session.
 *
 * One thread per task used to be the rule, for the prompt cache -- but the
 * cache lives an hour at most, so a daily task started cold anyway while paying
 * for an ever-longer context. The system prompt and tools are identical across
 * runs, so what can be cached still is. A fresh session also keeps one bad run
 * from steering the next, and makes each result readable on its own.
 *
 * The session carries the task's id, which keeps it out of the session list;
 * the run log links to it.
 */
async function createRunSession(task: TaskRecord, modelRefId: string, thinkingLevel: Session["thinkingLevel"]) {
  const timestamp = now();
  const session: Session = {
    id: id("session"),
    title: task.name,
    userId: task.userId,
    agentId: task.agentId,
    modelRefId,
    thinkingLevel,
    revision: 0,
    messages: [],
    messageEntryIds: [],
    taskId: task.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(sessions).values(toSessionRow(session)).run();
  return loadSession(session.id);
}

function maxConcurrent() {
  const configured = Number(process.env.CARMEL_AGENT_MAX_CONCURRENT_TASKS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_CONCURRENT;
}
