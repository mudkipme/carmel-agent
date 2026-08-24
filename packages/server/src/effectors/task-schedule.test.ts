import test from "node:test";
import assert from "node:assert/strict";
import {
  computeNextRun,
  DEFAULT_MISSED_GRACE_MS,
  MIN_INTERVAL_MS,
  planTaskFiring,
  validateSchedule,
  type TaskSchedule,
} from "./task-schedule.ts";

const at = (iso: string) => Date.parse(iso);

test("an interval schedule advances from the moment it last ran", () => {
  const next = computeNextRun({ kind: "interval", value: String(60_000) }, at("2026-08-24T10:00:00Z"));
  assert.deepEqual(next, { ok: true, at: at("2026-08-24T10:01:00Z") });
});

test("an interval below the floor is rejected rather than becoming a busy loop", () => {
  const next = computeNextRun({ kind: "interval", value: "500" }, 0);
  assert.equal(next.ok, false);
  assert.match(next.ok ? "" : next.reason, new RegExp(String(MIN_INTERVAL_MS)));
});

test("cron respects the task's timezone, not the server's", () => {
  const lisbon = computeNextRun(cron("0 9 * * *", "Europe/Lisbon"), at("2026-01-15T12:00:00Z"));
  const tokyo = computeNextRun(cron("0 9 * * *", "Asia/Tokyo"), at("2026-01-15T12:00:00Z"));
  assert.deepEqual(lisbon, { ok: true, at: at("2026-01-16T09:00:00Z") });
  assert.deepEqual(tokyo, { ok: true, at: at("2026-01-16T00:00:00Z") });
});

test("a daily cron stays at its local hour across a DST boundary", () => {
  // Europe/Lisbon springs forward on 2026-03-29, so 09:00 local moves from
  // 09:00Z to 08:00Z. Getting this right is the reason for the dependency.
  const before = computeNextRun(cron("0 9 * * *", "Europe/Lisbon"), at("2026-03-27T12:00:00Z"));
  const across = computeNextRun(cron("0 9 * * *", "Europe/Lisbon"), at("2026-03-28T12:00:00Z"));
  assert.deepEqual(before, { ok: true, at: at("2026-03-28T09:00:00Z") });
  assert.deepEqual(across, { ok: true, at: at("2026-03-29T08:00:00Z") });
});

test("an unparseable cron expression is reported, not silently dropped", () => {
  assert.equal(computeNextRun(cron("not a cron"), 0).ok, false);
});

test("a one-shot disarms itself once its instant has passed", () => {
  const schedule: TaskSchedule = { kind: "once", value: "2026-08-24T10:00:00Z" };
  assert.deepEqual(computeNextRun(schedule, at("2026-08-24T09:00:00Z")), { ok: true, at: at("2026-08-24T10:00:00Z") });
  // Re-armed after firing: nothing left, which is what completes the task.
  assert.deepEqual(computeNextRun(schedule, at("2026-08-24T10:00:00Z")), { ok: true, at: null });
});

test("a task that is not yet due stays idle", () => {
  assert.deepEqual(plan({ nextRunAt: at("2026-08-24T10:00:00Z"), now: at("2026-08-24T09:59:00Z") }), { action: "idle" });
});

test("a paused task never fires, however overdue", () => {
  assert.deepEqual(
    plan({ status: "paused", nextRunAt: at("2026-08-01T10:00:00Z"), now: at("2026-08-24T10:00:00Z") }),
    { action: "idle" },
  );
});

test("a due task fires and reports how late it was", () => {
  assert.deepEqual(plan({ nextRunAt: at("2026-08-24T10:00:00Z"), now: at("2026-08-24T10:00:30Z") }), {
    action: "fire",
    scheduledFor: at("2026-08-24T10:00:00Z"),
    lateMs: 30_000,
  });
});

test("an occurrence past the grace window is skipped and the schedule moves on", () => {
  // The restart-after-downtime case: a daily task due three days ago resumes
  // tomorrow rather than firing the moment the process comes back.
  const now = at("2026-08-24T12:00:00Z");
  const result = plan({
    schedule: cron("0 9 * * *", "UTC"),
    nextRunAt: at("2026-08-21T09:00:00Z"),
    now,
  });
  assert.deepEqual(result, {
    action: "skip_missed",
    scheduledFor: at("2026-08-21T09:00:00Z"),
    nextRunAt: at("2026-08-25T09:00:00Z"),
  });
});

test("a one-shot fires however late, because skipping it means never", () => {
  // Deliberately exempt from the grace window. Skipping one occurrence of a
  // recurring task costs a run; skipping a one-shot loses it entirely.
  const result = plan({
    schedule: { kind: "once", value: "2026-08-21T09:00:00Z" },
    nextRunAt: at("2026-08-21T09:00:00Z"),
    now: at("2026-08-24T12:00:00Z"),
  });
  assert.equal(result.action, "fire");
});

test("a task with nothing left scheduled reports complete", () => {
  assert.deepEqual(plan({ nextRunAt: null, now: 0 }), { action: "complete" });
});

test("a due task whose schedule has gone bad is disabled, not retried forever", () => {
  const result = plan({
    schedule: cron("not a cron"),
    nextRunAt: at("2026-08-01T10:00:00Z"),
    now: at("2026-08-24T10:00:00Z"),
  });
  assert.equal(result.action, "disable");
});

test("validation rejects at write time what would otherwise disable later", () => {
  const now = at("2026-08-24T10:00:00Z");
  assert.deepEqual(validateSchedule(cron("0 9 * * *", "UTC"), now), { ok: true });
  assert.equal(validateSchedule(cron("nope"), now).ok, false);
  assert.equal(validateSchedule({ kind: "interval", value: "10" }, now).ok, false);
  // A one-shot in the past would arm to null and complete without ever running.
  assert.equal(validateSchedule({ kind: "once", value: "2020-01-01T00:00:00Z" }, now).ok, false);
  assert.equal(validateSchedule({ kind: "once", value: "2030-01-01T00:00:00Z" }, now).ok, true);
});

test("the grace window is long enough to absorb a slow tick", () => {
  assert.ok(DEFAULT_MISSED_GRACE_MS >= 60_000);
});

function cron(value: string, timezone?: string): TaskSchedule {
  return { kind: "cron", value, timezone };
}

function plan(overrides: Partial<Parameters<typeof planTaskFiring>[0]>) {
  return planTaskFiring({
    status: "active",
    schedule: { kind: "interval", value: String(60_000) },
    nextRunAt: null,
    now: 0,
    ...overrides,
  });
}
