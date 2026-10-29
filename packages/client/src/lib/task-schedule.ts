import { i18n } from "@lingui/core";
import type { AgentTask, AgentTaskCreateCommand, AgentTaskRun } from "@carmel-agent/shared";

export function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function emptyTaskDraft(): AgentTaskCreateCommand {
  return {
    name: "",
    prompt: "",
    scheduleKind: "cron",
    scheduleValue: "0 9 * * *",
    timezone: localTimezone(),
  };
}

export function taskDraft(task: AgentTask): AgentTaskCreateCommand {
  return {
    name: task.name,
    prompt: task.prompt,
    scheduleKind: task.scheduleKind,
    scheduleValue: task.scheduleValue,
    timezone: task.timezone,
    modelRefId: task.modelRefId,
    thinkingLevel: task.thinkingLevel,
    notifyPlatform: task.notifyPlatform,
  };
}

export function formatTaskTime(value: number) {
  return Number.isFinite(value)
    ? new Date(value).toLocaleString(i18n.locale, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : i18n._("Unknown time");
}

export function describeTaskSchedule(
  task: Pick<AgentTask, "scheduleKind" | "scheduleValue" | "timezone">,
) {
  if (task.scheduleKind === "interval") {
    const minutes = Number(task.scheduleValue) / 60_000;
    for (const [unit, size] of [
      ["week", 10_080],
      ["day", 1_440],
      ["hour", 60],
      ["minute", 1],
    ] as const) {
      if (minutes >= size && minutes % size === 0) {
        const amount = minutes / size;
        return {
          week: i18n._("{amount, plural, one {Every week} other {Every # weeks}}", { amount }),
          day: i18n._("{amount, plural, one {Every day} other {Every # days}}", { amount }),
          hour: i18n._("{amount, plural, one {Every hour} other {Every # hours}}", { amount }),
          minute: i18n._("{amount, plural, one {Every minute} other {Every # minutes}}", {
            amount,
          }),
        }[unit];
      }
    }
    return i18n._("{amount, plural, one {Every second} other {Every # seconds}}", {
      amount: Number(task.scheduleValue) / 1_000,
    });
  }
  if (task.scheduleKind === "once")
    return i18n._("Once at {value}", { value: formatTaskTime(Date.parse(task.scheduleValue)) });
  const [minute, hour, day, month, weekday, extra] = task.scheduleValue.trim().split(/\s+/);
  const timezone = task.timezone ? ` (${task.timezone})` : "";
  if (
    !extra &&
    /^\d+$/.test(minute ?? "") &&
    /^\d+$/.test(hour ?? "") &&
    Number(minute) < 60 &&
    Number(hour) < 24 &&
    day === "*" &&
    month === "*"
  ) {
    const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
    if (weekday === "*")
      return i18n._("Every day at {time}{timezone}", { time: time, timezone: timezone });
    if (weekday === "1-5")
      return i18n._("Every weekday at {time}{timezone}", { time: time, timezone: timezone });
    const weekdays = [
      i18n._("Sunday"),
      i18n._("Monday"),
      i18n._("Tuesday"),
      i18n._("Wednesday"),
      i18n._("Thursday"),
      i18n._("Friday"),
      i18n._("Saturday"),
      i18n._("Sunday"),
    ];
    if (/^[0-7]$/.test(weekday ?? ""))
      return i18n._("Every {weekday} at {time}{timezone}", {
        weekday: weekdays[Number(weekday)],
        time,
        timezone,
      });
  }
  return i18n._("Cron: {scheduleValue}{timezone}", {
    scheduleValue: task.scheduleValue,
    timezone: timezone,
  });
}

export function describeTaskState(task: AgentTask) {
  if (task.status === "paused") return i18n._("Paused");
  if (task.status === "completed") return i18n._("Completed");
  if (task.status === "disabled")
    return i18n._("Disabled · {value}", {
      value: task.lastError ?? i18n._("Unable to read the schedule"),
    });
  const next = task.nextRunAt
    ? i18n._("Next run: {value}", { value: formatTaskTime(task.nextRunAt) })
    : i18n._("Not scheduled");
  if (!task.lastRunAt) return next;
  const last = i18n._("{next} · Last run: {value} · {value2}", {
    next: next,
    value: describeTaskOutcome(task.lastOutcome ?? "succeeded"),
    value2: formatTaskTime(task.lastRunAt),
  });
  return task.lastError && task.lastOutcome !== "succeeded" ? `${last} · ${task.lastError}` : last;
}

export function describeTaskOutcome(outcome: AgentTaskRun["outcome"]) {
  return {
    running: i18n._("Running"),
    succeeded: i18n._("Succeeded"),
    failed: i18n._("Failed"),
    cancelled: i18n._("Cancelled"),
    interrupted: i18n._("Interrupted"),
    missed: i18n._("Missed"),
    skipped: i18n._("Skipped"),
  }[outcome];
}
