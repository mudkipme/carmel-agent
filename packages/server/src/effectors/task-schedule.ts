import { CronExpressionParser } from "cron-parser";

/**
 * When a scheduled task should next run, and whether a due one should fire.
 *
 * Pure and clock-injected, like the rest of `effectors/`. Every interesting case
 * here is about elapsed time, a calendar, or a daylight-saving boundary, and
 * none of them should need a real timer, a database, or a model to test.
 */

export type TaskScheduleKind = "cron" | "interval" | "once";

export type TaskSchedule = {
  readonly kind: TaskScheduleKind;
  /** Cron expression, interval in milliseconds, or an ISO instant. */
  readonly value: string;
  /** IANA zone for cron. Ignored by the other kinds, which are absolute. */
  readonly timezone?: string | null;
};

export type NextRun =
  /** `at` is null when the schedule has no further occurrences. */
  | { readonly ok: true; readonly at: number | null }
  | { readonly ok: false; readonly reason: string };

/**
 * The next occurrence strictly after `from`.
 *
 * Called both to arm a new task (`from` = creation) and to re-arm one after it
 * fires (`from` = the firing). A `once` task therefore disarms itself naturally:
 * its instant is in the past by the time it is re-armed.
 */
export function computeNextRun(schedule: TaskSchedule, from: number): NextRun {
  switch (schedule.kind) {
    case "cron":
      return computeCronNextRun(schedule, from);

    case "interval": {
      const ms = Number(schedule.value);
      if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS) {
        return { ok: false, reason: `Interval must be at least ${MIN_INTERVAL_MS}ms.` };
      }
      return { ok: true, at: from + Math.floor(ms) };
    }

    case "once": {
      const at = Date.parse(schedule.value);
      if (Number.isNaN(at)) return { ok: false, reason: "Not a valid date." };
      return { ok: true, at: at > from ? at : null };
    }
  }
}

/** Below this, a task is a busy loop rather than a schedule. */
export const MIN_INTERVAL_MS = 30_000;

/**
 * How late a recurring occurrence may be and still run.
 *
 * Past this, the occurrence is recorded as missed and the schedule is recomputed
 * from now rather than replayed. The point is a restart after downtime: a daily
 * task that was due three days ago should resume tomorrow, not fire the moment
 * the process comes back.
 */
export const DEFAULT_MISSED_GRACE_MS = 5 * 60_000;

export type TaskFiringInput = {
  readonly status: "active" | "paused" | "completed";
  readonly schedule: TaskSchedule;
  readonly nextRunAt: number | null;
  readonly now: number;
  readonly graceMs?: number;
};

export type TaskFiringPlan =
  /** Not due, paused, or already finished. */
  | { readonly action: "idle" }
  | { readonly action: "fire"; readonly scheduledFor: number; readonly lateMs: number }
  /** Too late to run. Record the miss and move on to `nextRunAt`. */
  | { readonly action: "skip_missed"; readonly scheduledFor: number; readonly nextRunAt: number | null }
  /** Nothing left to schedule. */
  | { readonly action: "complete" }
  /** The schedule cannot be parsed; running it again would fail identically. */
  | { readonly action: "disable"; readonly reason: string };

export function planTaskFiring(input: TaskFiringInput): TaskFiringPlan {
  if (input.status !== "active") return { action: "idle" };
  if (input.nextRunAt === null) return { action: "complete" };
  if (input.now < input.nextRunAt) return { action: "idle" };

  const lateMs = input.now - input.nextRunAt;
  const grace = input.graceMs ?? DEFAULT_MISSED_GRACE_MS;

  // A one-shot is exempt from the grace window. Skipping a recurring occurrence
  // costs one run; skipping a one-shot means the thing the user asked for never
  // happens at all, which is a different kind of failure.
  if (input.schedule.kind !== "once" && lateMs > grace) {
    const next = computeNextRun(input.schedule, input.now);
    if (!next.ok) return { action: "disable", reason: next.reason };
    return { action: "skip_missed", scheduledFor: input.nextRunAt, nextRunAt: next.at };
  }

  return { action: "fire", scheduledFor: input.nextRunAt, lateMs };
}

function computeCronNextRun(schedule: TaskSchedule, from: number): NextRun {
  try {
    const next = CronExpressionParser.parse(schedule.value, {
      // Falls back to the process zone. A task without one still behaves, it
      // just follows the server rather than the person who wrote it.
      tz: schedule.timezone || undefined,
      currentDate: new Date(from),
    })
      .next()
      .getTime();
    return { ok: true, at: next };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Not a valid cron expression." };
  }
}

/** Validate a schedule at write time so a bad one is rejected, not disabled later. */
export function validateSchedule(schedule: TaskSchedule, now: number): { ok: true } | { ok: false; reason: string } {
  const next = computeNextRun(schedule, now);
  if (!next.ok) return { ok: false, reason: next.reason };
  if (schedule.kind === "once" && next.at === null) return { ok: false, reason: "That time is in the past." };
  return { ok: true };
}
