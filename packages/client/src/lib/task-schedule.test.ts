import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTaskSchedule } from "./task-schedule.ts";
import { i18n } from "@lingui/core";

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

test("Chinese schedules translate full phrases and retain the time and zone", (t) => {
  t.after(() => i18n.activate("en"));
  for (const [locale, expected, weekday] of [
    ["zh-Hans", "每小时", "每周一 09:00 (Asia/Singapore)"],
    ["zh-Hant", "每小時", "每週一 09:00 (Asia/Singapore)"],
  ] as const) {
    i18n.activate(locale);
    assert.equal(
      describeTaskSchedule({ scheduleKind: "interval", scheduleValue: "3600000" }),
      expected,
    );
    assert.equal(
      describeTaskSchedule({
        scheduleKind: "cron",
        scheduleValue: "0 9 * * 1",
        timezone: "Asia/Singapore",
      }),
      weekday,
    );
  }
});
