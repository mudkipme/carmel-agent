import { useCallback, useEffect, useState } from "react";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { AgentTask, AgentTaskCreateCommand } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SectionHeader } from "@/components/harness/form-primitives";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * Scheduled tasks for one agent.
 *
 * Unlike the other tabs in this dialog, tasks are their own resource rather
 * than fields of the agent draft, so edits here save immediately instead of
 * waiting for the dialog's Save. That matches what they are: a task keeps
 * running whether or not the agent is being edited.
 */
export function AgentTasksPanel({ agentId }: { agentId: string }) {
  const [tasks, setTasks] = useState<AgentTask[] | undefined>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<AgentTaskCreateCommand | undefined>();

  const reload = useCallback(async () => {
    try {
      setTasks(await api.listAgentTasks(agentId));
      setError(undefined);
    } catch (loadError) {
      setError(errorMessage(loadError, "Unable to load tasks"));
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try {
      await action();
      setError(undefined);
      await reload();
    } catch (actionError) {
      setError(errorMessage(actionError, fallback));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-4">
      <SectionHeader
        title="Scheduled tasks"
        description="Each task prompts this agent on a schedule, in its own session, whether or not you have carmel open."
      />

      {tasks === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No scheduled tasks yet.</p>
      ) : (
        <ul className="grid gap-2">
          {tasks.map((task) => (
            <li key={task.id} className="grid gap-1 rounded-md border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{task.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{describeSchedule(task)}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    title="Run now"
                    onClick={() => void act(() => api.runAgentTaskNow(agentId, task.id), "Unable to run task")}
                  >
                    <PlayIcon data-icon="inline-start" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          api.updateAgentTask(agentId, task.id, {
                            status: task.status === "active" ? "paused" : "active",
                          }),
                        "Unable to update task",
                      )
                    }
                  >
                    {task.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(() => api.deleteAgentTask(agentId, task.id), "Unable to delete task")}
                  >
                    <Trash2Icon data-icon="inline-start" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{describeState(task)}</p>
            </li>
          ))}
        </ul>
      )}

      {draft ? (
        <div className="grid gap-3 rounded-md border p-3">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel>Prompt</FieldLabel>
            <Textarea
              rows={3}
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel>Repeats</FieldLabel>
              <Select
                value={draft.scheduleKind}
                onValueChange={(value) =>
                  setDraft({ ...draft, scheduleKind: value as AgentTask["scheduleKind"], scheduleValue: defaultValueFor(value) })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cron">On a cron schedule</SelectItem>
                  <SelectItem value="interval">Every N minutes</SelectItem>
                  <SelectItem value="once">Once, at a time</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>{scheduleValueLabel(draft.scheduleKind)}</FieldLabel>
              <Input
                value={displayValue(draft)}
                placeholder={placeholderFor(draft.scheduleKind)}
                onChange={(event) => setDraft({ ...draft, scheduleValue: storedValue(draft.scheduleKind, event.target.value) })}
              />
            </Field>
          </div>
          {draft.scheduleKind === "cron" ? (
            <Field>
              <FieldLabel>Time zone</FieldLabel>
              <Input
                value={draft.timezone ?? ""}
                placeholder={localTimezone()}
                onChange={(event) => setDraft({ ...draft, timezone: event.target.value || undefined })}
              />
            </Field>
          ) : null}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !draft.name.trim() || !draft.prompt.trim()}
              onClick={() =>
                void act(async () => {
                  await api.createAgentTask(agentId, { ...draft, timezone: draft.timezone || localTimezone() });
                  setDraft(undefined);
                }, "Unable to create task")
              }
            >
              Create task
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="outline" size="sm" onClick={() => setDraft(emptyDraft())}>
            <PlusIcon data-icon="inline-start" />
            New task
          </Button>
        </div>
      )}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}

function emptyDraft(): AgentTaskCreateCommand {
  return { name: "", prompt: "", scheduleKind: "cron", scheduleValue: "0 9 * * *", timezone: localTimezone() };
}

function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Minutes are the unit people think in; the API stores milliseconds. */
function displayValue(draft: AgentTaskCreateCommand) {
  if (draft.scheduleKind !== "interval") return draft.scheduleValue;
  const minutes = Number(draft.scheduleValue) / 60_000;
  return Number.isFinite(minutes) && minutes > 0 ? String(minutes) : "";
}

function storedValue(kind: AgentTask["scheduleKind"], input: string) {
  if (kind !== "interval") return input;
  const minutes = Number(input);
  return Number.isFinite(minutes) ? String(Math.round(minutes * 60_000)) : input;
}

function defaultValueFor(kind: string) {
  if (kind === "interval") return String(60 * 60_000);
  if (kind === "once") return new Date(Date.now() + 3_600_000).toISOString();
  return "0 9 * * *";
}

function scheduleValueLabel(kind: AgentTask["scheduleKind"]) {
  if (kind === "interval") return "Minutes";
  if (kind === "once") return "When (ISO)";
  return "Cron expression";
}

function placeholderFor(kind: AgentTask["scheduleKind"]) {
  if (kind === "interval") return "60";
  if (kind === "once") return "2026-09-01T09:00:00Z";
  return "0 9 * * *";
}

function describeSchedule(task: AgentTask) {
  if (task.scheduleKind === "interval") return `Every ${Math.round(Number(task.scheduleValue) / 60_000)} min`;
  if (task.scheduleKind === "once") return `Once at ${formatTime(Date.parse(task.scheduleValue))}`;
  return `${task.scheduleValue}${task.timezone ? ` (${task.timezone})` : ""}`;
}

function describeState(task: AgentTask) {
  if (task.status === "paused") return "Paused";
  if (task.status === "completed") return "Completed";
  if (task.status === "disabled") return `Disabled — ${task.lastError ?? "the schedule could not be read"}`;
  const next = task.nextRunAt ? `Next ${formatTime(task.nextRunAt)}` : "Not scheduled";
  if (!task.lastRunAt) return next;
  return `${next} · Last ${task.lastOutcome ?? "ran"} ${formatTime(task.lastRunAt)}`;
}

function formatTime(value: number) {
  if (!Number.isFinite(value)) return "unknown";
  return new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
