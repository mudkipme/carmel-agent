import { CircleDotIcon, CpuIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ModelCommandDialog } from "@/components/chat/ModelCommandDialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { showError } from "@/lib/errors";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, ModelRef, ProviderConfig } from "@carmel-agent/shared";

/**
 * Opening an issue hands the agent a brief and lets it get on with it: the
 * run starts on the server as the issue is created, so the page can be closed
 * straight away.
 */
export function NewIssueView({
  agent,
  modelRefs,
  providerConfigs,
}: {
  agent: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
}) {
  const navigate = useNavigate();
  const createIssue = useHarnessStore((state) => state.createIssue);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [modelRefId, setModelRefId] = useState(agent.defaultModelRefId);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const modelRef = modelRefs.find((model) => model.id === modelRefId) ?? modelRefs.find((model) => model.id === agent.defaultModelRefId);
  const canSubmit = Boolean(title.trim() && description.trim() && modelRef) && !submitting;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !modelRef) return;
    setSubmitting(true);
    try {
      const issue = await createIssue(agent.id, {
        title: title.trim(),
        description: description.trim(),
        modelRefId: modelRef.id === agent.defaultModelRefId ? undefined : modelRef.id,
      });
      navigate(`/agents/${agent.id}/issues/${issue.id}`);
    } catch (error) {
      showError("Unable to open issue", error);
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background px-3 pb-[calc(0.75rem+var(--safe-bottom))]">
      <form
        className="mx-auto my-auto flex w-full max-w-[var(--line-width)] min-w-0 flex-col gap-5 py-8"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-xl font-medium">
            <CircleDotIcon className="size-5 text-muted-foreground" />
            New issue
          </h1>
          <p className="text-sm text-muted-foreground">
            {agent.name} starts working as soon as the issue is opened, and keeps going with the page closed. You can
            reply, interrupt, or cancel it from the issue.
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="issue-title">Title</FieldLabel>
          <Input
            id="issue-title"
            autoFocus
            maxLength={200}
            placeholder="Upgrade the test runner to v5"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="issue-description">Description</FieldLabel>
          <Textarea
            id="issue-description"
            className="min-h-48"
            placeholder="What needs doing, and how to tell it is done."
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit(event);
            }}
          />
          <FieldDescription>Thinking and tool calls are folded away in the issue; open them when you need the detail.</FieldDescription>
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setModelDialogOpen(true)} disabled={!modelRef}>
            <CpuIcon data-icon="inline-start" />
            {modelRef?.label ?? "No model"}
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {submitting ? "Opening…" : "Open issue"}
          </Button>
        </div>
      </form>
      <ModelCommandDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        modelRefs={modelRefs}
        providerConfigs={providerConfigs}
        selectedModelRefId={modelRef?.id ?? ""}
        onSelect={(next) => {
          setModelDialogOpen(false);
          setModelRefId(next.id);
        }}
      />
    </div>
  );
}
