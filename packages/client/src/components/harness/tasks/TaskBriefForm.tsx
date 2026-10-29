import { priorityLabel } from "@/lib/labels";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { type FormEvent } from "react";
import type { IssueCreateCommand, IssuePriority } from "@carmel-agent/shared";
import { useSessionDraft } from "@/hooks/use-session-draft";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
export function TaskBriefForm({
  initial,
  draftKey,
  busy,
  onSave,
  onCancel,
}: {
  initial?: IssueCreateCommand;
  draftKey?: string;
  busy: boolean;
  onSave: (draft: IssueCreateCommand) => void;
  onCancel?: () => void;
}) {
  const { i18n } = useLingui();
  const [draft, setDraft] = useSessionDraft(
    draftKey,
    {
      title: initial?.title ?? "",
      description: initial?.description ?? "",
      criteria: initial?.criteria?.join("\n") ?? "",
      priority: initial?.priority ?? "normal",
    },
    isBriefDraft,
  );
  const { title, description, criteria, priority } = draft;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    onSave({
      title: title.trim(),
      description: description.trim(),
      criteria: criteria
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      priority,
      ...(!initial
        ? {
            status: "backlog",
            queue: (event.nativeEvent as SubmitEvent).submitter?.getAttribute("name") === "queue",
          }
        : {}),
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="issue-title">
            <Trans>Title</Trans>
          </FieldLabel>
          <Input
            id="issue-title"
            autoFocus
            required
            maxLength={200}
            value={title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder={i18n._("What needs to change?")}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="issue-description">
            <Trans>Details</Trans>{" "}
            <span className="text-muted-foreground">
              <Trans>(optional)</Trans>
            </span>
          </FieldLabel>
          <Textarea
            id="issue-description"
            maxLength={40000}
            className="min-h-40"
            value={description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder={i18n._("Describe the outcome, context, and constraints.")}
          />
        </Field>
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            <Trans>Acceptance criteria & priority</Trans>
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            {" "}
            <Field>
              <FieldLabel htmlFor="issue-criteria">
                <Trans>Acceptance criteria</Trans>
              </FieldLabel>
              <Textarea
                id="issue-criteria"
                className="min-h-24"
                value={criteria}
                onChange={(e) => setDraft({ ...draft, criteria: e.target.value })}
                placeholder={i18n._("One criterion per line")}
              />
            </Field>
            <div className="flex flex-wrap gap-4">
              <Field className="w-40">
                <FieldLabel htmlFor="issue-priority">
                  <Trans>Priority</Trans>
                </FieldLabel>
                <Select
                  value={priority}
                  onValueChange={(v) => setDraft({ ...draft, priority: v as IssuePriority })}
                >
                  <SelectTrigger id="issue-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(["low", "normal", "high", "urgent"] as const).map((v) => (
                        <SelectItem key={v} value={v}>
                          {priorityLabel(v)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </div>
        </details>
      </FieldGroup>
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
        <Button
          type="submit"
          variant={initial ? "default" : "outline"}
          disabled={busy || !title.trim()}
        >
          {busy ? i18n._("Saving…") : initial ? i18n._("Save brief") : i18n._("Save to backlog")}
        </Button>
        {!initial ? (
          <Button type="submit" name="queue" disabled={busy || !title.trim()}>
            <Trans>Queue work</Trans>
          </Button>
        ) : null}
      </div>
    </form>
  );
}

type BriefDraft = {
  title: string;
  description: string;
  criteria: string;
  priority: IssuePriority;
};
function isBriefDraft(value: unknown): value is BriefDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<BriefDraft>;
  return (
    typeof draft.title === "string" &&
    typeof draft.description === "string" &&
    typeof draft.criteria === "string" &&
    ["low", "normal", "high", "urgent"].includes(draft.priority ?? "")
  );
}
