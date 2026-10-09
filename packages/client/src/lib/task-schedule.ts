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
  };
}

export function formatTaskTime(value: number) {
  return Number.isFinite(value)
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown time";
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
        return amount === 1 ? `Every ${unit}` : `Every ${amount} ${unit}s`;
      }
    }
    return `Every ${Number(task.scheduleValue) / 1_000} seconds`;
  }
  if (task.scheduleKind === "once")
    return `Once at ${formatTaskTime(Date.parse(task.scheduleValue))}`;
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
    if (weekday === "*") return `Every day at ${time}${timezone}`;
    if (weekday === "1-5") return `Every weekday at ${time}${timezone}`;
    const weekdays = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ];
    if (/^[0-7]$/.test(weekday ?? ""))
      return `Every ${weekdays[Number(weekday)]} at ${time}${timezone}`;
  }
  return `Cron: ${task.scheduleValue}${timezone}`;
}

export function describeTaskState(task: AgentTask) {
  if (task.status === "paused") return "Paused";
  if (task.status === "completed") return "Completed";
  if (task.status === "disabled")
    return `Disabled · ${task.lastError ?? "Unable to read the schedule"}`;
  const next = task.nextRunAt ? `Next run: ${formatTaskTime(task.nextRunAt)}` : "Not scheduled";
  if (!task.lastRunAt) return next;
  const last = `${next} · Last run: ${describeTaskOutcome(task.lastOutcome ?? "succeeded")} · ${formatTaskTime(task.lastRunAt)}`;
  return task.lastError && task.lastOutcome !== "succeeded" ? `${last} · ${task.lastError}` : last;
}

export function describeTaskOutcome(outcome: AgentTaskRun["outcome"]) {
  return {
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    missed: "Missed",
    skipped: "Skipped",
  }[outcome];
}
