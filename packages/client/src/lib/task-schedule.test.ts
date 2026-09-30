import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTaskSchedule } from "./task-schedule.ts";

test("interval schedules use exact familiar units", () => {
  for (const [milliseconds, expected] of [
    [86400000, "Every day"],
    [7200000, "Every 2 hours"],
    [5400000, "Every 90 minutes"],
    [30000, "Every 30 seconds"],
  ] as const) {
    assert.equal(
      describeTaskSchedule({
        scheduleKind: "interval",
        scheduleValue: String(milliseconds),
      }),
      expected,
    );
  }
});

test("common cron schedules retain their time zone; complex expressions remain explicit", () => {
  assert.equal(
    describeTaskSchedule({
      scheduleKind: "cron",
      scheduleValue: "0 9 * * *",
      timezone: "Asia/Singapore",
    }),
    "Every day at 09:00 (Asia/Singapore)",
  );
  assert.equal(
    describeTaskSchedule({
      scheduleKind: "cron",
      scheduleValue: "30 8 * * 1-5",
    }),
    "Every weekday at 08:30",
  );
  assert.equal(
    describeTaskSchedule({ scheduleKind: "cron", scheduleValue: "0 9 * * 1" }),
    "Every Monday at 09:00",
  );
  assert.equal(
    describeTaskSchedule({
      scheduleKind: "cron",
      scheduleValue: "*/15 * * * *",
    }),
    "Cron: */15 * * * *",
  );
});
