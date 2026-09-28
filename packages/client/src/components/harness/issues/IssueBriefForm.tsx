import { useState, type FormEvent } from "react";
import type { IssueCreateCommand, IssuePriority } from "@carmel-agent/shared";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
export function IssueBriefForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial?: IssueCreateCommand;
  busy: boolean;
  onSave: (draft: IssueCreateCommand) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [criteria, setCriteria] = useState(initial?.criteria?.join("\n") ?? "");
  const [priority, setPriority] = useState<IssuePriority>(initial?.priority ?? "normal");
  const [status, setStatus] = useState<"backlog" | "todo">(initial?.status ?? "todo");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !description.trim() || busy) return;
    onSave({
      title: title.trim(),
      description: description.trim(),
      criteria: criteria
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      priority,
      ...(!initial ? { status } : {}),
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="issue-title">Title</FieldLabel>
          <Input
            id="issue-title"
            autoFocus
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to change?"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="issue-description">Brief</FieldLabel>
          <Textarea
            id="issue-description"
            required
            maxLength={40000}
            className="min-h-40"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the outcome, context, and constraints."
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="issue-criteria">Acceptance criteria</FieldLabel>
          <Textarea
            id="issue-criteria"
            className="min-h-24"
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="One criterion per line"
          />
          <FieldDescription>What will you check before accepting the result?</FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-4">
          <Field className="w-40">
            <FieldLabel htmlFor="issue-priority">Priority</FieldLabel>
            <Select value={priority} onValueChange={(v) => setPriority(v as IssuePriority)}>
              <SelectTrigger id="issue-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {["low", "normal", "high", "urgent"].map((v) => (
                    <SelectItem key={v} value={v}>
                      {v[0]!.toUpperCase() + v.slice(1)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {!initial ? (
            <Field className="w-40">
              <FieldLabel htmlFor="issue-status">Status</FieldLabel>
              <Select value={status} onValueChange={(v) => setStatus(v as "backlog" | "todo")}>
                <SelectTrigger id="issue-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="todo">To do</SelectItem>
                    <SelectItem value="backlog">Backlog</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>
      </FieldGroup>
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={busy || !title.trim() || !description.trim()}>
          {busy ? "Saving…" : initial ? "Save brief" : "Create issue"}
        </Button>
      </div>
    </form>
  );
}
