import type { FormEvent } from "react";
import { agentTaskCreateSchema, type AgentTaskCreateCommand } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useSessionDraft } from "@/hooks/use-session-draft";
import { describeTaskSchedule, localTimezone } from "@/lib/task-schedule";

export function TaskForm({
  initial,
  draftKey,
  editing,
  busy,
  onSave,
  onCancel,
}: {
  initial: AgentTaskCreateCommand;
  draftKey: string;
  editing: boolean;
  busy: boolean;
  onSave: (draft: AgentTaskCreateCommand) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useSessionDraft(
    draftKey,
    initial,
    (value): value is AgentTaskCreateCommand =>
      // Incomplete text fields are valid drafts, but never valid API submissions.
      Boolean(
        value &&
        typeof value === "object" &&
        "name" in value &&
        typeof value.name === "string" &&
        "prompt" in value &&
        typeof value.prompt === "string" &&
        "scheduleValue" in value &&
        typeof value.scheduleValue === "string" &&
        agentTaskCreateSchema.safeParse({
          ...value,
          name: "Draft",
          prompt: "Draft",
          scheduleValue: "Pending",
        }).success,
      ),
  );
  const update = (patch: Partial<AgentTaskCreateCommand>) => setDraft({ ...draft, ...patch });
  const intervalMinutes =
    draft.scheduleKind === "interval" ? Number(draft.scheduleValue) / 60_000 : 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !draft.name.trim() || !draft.prompt.trim()) return;
    void onSave({
      ...draft,
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      timezone: draft.timezone || localTimezone(),
    });
  };
  return (
    <form
      onSubmit={submit}
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-3 sm:p-4"
    >
      <h2 className="text-sm font-semibold">{editing ? "Edit schedule" : "New schedule"}</h2>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="task-name">Name</FieldLabel>
          <Input
            id="task-name"
            autoFocus
            required
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="task-prompt">Prompt</FieldLabel>
          <Textarea
            id="task-prompt"
            required
            rows={4}
            value={draft.prompt}
            onChange={(event) => update({ prompt: event.target.value })}
          />
        </Field>
        <FieldGroup className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="task-repeats">Repeats</FieldLabel>
            <Select
              value={draft.scheduleKind}
              onValueChange={(value) =>
                update({
                  scheduleKind: value as AgentTaskCreateCommand["scheduleKind"],
                  scheduleValue:
                    value === "interval"
                      ? "3600000"
                      : value === "once"
                        ? new Date(Date.now() + 3_600_000).toISOString()
                        : "0 9 * * *",
                })
              }
            >
              <SelectTrigger id="task-repeats" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="cron">On a cron schedule</SelectItem>
                  <SelectItem value="interval">Every N minutes</SelectItem>
                  <SelectItem value="once">Once, at a time</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="task-schedule">
              {draft.scheduleKind === "interval"
                ? "Minutes"
                : draft.scheduleKind === "once"
                  ? "When (ISO date and time)"
                  : "Cron expression"}
            </FieldLabel>
            <Input
              id="task-schedule"
              required
              type={draft.scheduleKind === "interval" ? "number" : "text"}
              min={draft.scheduleKind === "interval" ? 1 : undefined}
              value={
                draft.scheduleKind === "interval"
                  ? intervalMinutes > 0
                    ? intervalMinutes
                    : ""
                  : draft.scheduleValue
              }
              onChange={(event) =>
                update({
                  scheduleValue:
                    draft.scheduleKind === "interval"
                      ? String(Number(event.target.value) * 60_000)
                      : event.target.value,
                })
              }
            />
            {draft.scheduleKind !== "interval" ? (
              <FieldDescription>
                {draft.scheduleKind === "cron"
                  ? "Minute, hour, day of month, month, weekday."
                  : "Include a time zone, for example 2026-10-01T09:00:00+08:00."}
              </FieldDescription>
            ) : null}
          </Field>
        </FieldGroup>
        {draft.scheduleKind === "cron" ? (
          <Field>
            <FieldLabel htmlFor="task-timezone">Time zone</FieldLabel>
            <Input
              id="task-timezone"
              value={draft.timezone ?? ""}
              placeholder={localTimezone()}
              onChange={(event) => update({ timezone: event.target.value })}
            />
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor="task-notifications">Notification destination</FieldLabel>
          <Select
            value={draft.notifyPlatform ?? "none"}
            onValueChange={(value) =>
              update({
                notifyPlatform:
                  value === "none"
                    ? undefined
                    : (value as AgentTaskCreateCommand["notifyPlatform"]),
              })
            }
          >
            <SelectTrigger id="task-notifications">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="none">Task history only</SelectItem>
                <SelectItem value="telegram">Telegram</SelectItem>
                <SelectItem value="feishu">Feishu</SelectItem>
                <SelectItem value="lark">Lark</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            Connect your bot in this agent's Integrations settings first. Describe when to notify
            you in the prompt, including any conditions.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <p className="text-sm text-muted-foreground">{describeTaskSchedule(draft)}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !draft.name.trim() || !draft.prompt.trim()}>
          {busy ? "Saving…" : editing ? "Save schedule" : "Create schedule"}
        </Button>
      </div>
    </form>
  );
}
