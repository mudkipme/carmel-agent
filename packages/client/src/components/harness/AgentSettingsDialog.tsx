import { PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import { api } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, AgentPermissions, ModelRef, ProviderConfig } from "@carmel-agent/shared";

export function AgentSettingsDialog({
  agent,
  modelRefs,
  providerConfigs,
}: {
  agent: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
}) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const [open, setOpen] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState<AgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void api
      .getAgentSettings(agent.id, activeUserId)
      .then((payload) => {
        if (!cancelled) setSettingsAgent(payload);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load agent settings");
      });
    return () => {
      cancelled = true;
    };
  }, [activeUserId, agent.id, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setSettingsAgent(null);
      setError(null);
    }
    setOpen(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          title="Agent settings"
        >
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Agent Settings</DialogTitle>
          <DialogDescription>Configure this agent's workspace, prompt, model, and permissions.</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : settingsAgent ? (
          <AgentSettings
            key={settingsAgent.id}
            agent={settingsAgent}
            modelRefs={modelRefs}
            providerConfigs={providerConfigs}
            onDeleted={() => setOpen(false)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Loading agent settings...</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AgentSettings({
  agent,
  modelRefs,
  providerConfigs,
  onDeleted,
}: {
  agent: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  onDeleted?: () => void;
}) {
  const upsertAgent = useHarnessStore((state) => state.upsertAgent);
  const deleteAgent = useHarnessStore((state) => state.deleteAgent);
  const [draft, setDraft] = useState(agent);
  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("");

  const saveAgent = (patch: Partial<AgentConfig>) => {
    setDraft((current) => {
      const next = { ...current, ...patch, updatedAt: Date.now() };
      void upsertAgent(next);
      return next;
    });
  };

  const removeAgent = async () => {
    const confirmed = window.confirm(`Delete ${agent.name} and all of its sessions?`);
    if (!confirmed) return;
    try {
      await deleteAgent(agent.id);
      onDeleted?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to delete agent");
    }
  };

  const addPromptTemplate = () => {
    const name = templateName.trim();
    const body = templateBody.trim();
    if (!name || !body) return;
    saveAgent({
      promptTemplates: [
        ...draft.promptTemplates,
        {
          id: createClientId("template"),
          name,
          body,
        },
      ],
    });
    setTemplateName("");
    setTemplateBody("");
  };

  const deletePromptTemplate = (templateId: string) => {
    saveAgent({
      promptTemplates: draft.promptTemplates.filter((template) => template.id !== templateId),
    });
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        <SectionHeader title="Agent" description="Working directory, sharing, global skills, and system prompt." />
        <div className="grid gap-3">
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              onBlur={(event) => saveAgent({ name: event.currentTarget.value })}
            />
          </Field>
          <Field label="Working dir">
            <Input
              value={draft.workingDir}
              onChange={(event) => setDraft((current) => ({ ...current, workingDir: event.target.value }))}
              onBlur={(event) => saveAgent({ workingDir: event.currentTarget.value })}
            />
          </Field>
          <Field label="Global skills">
            <Input
              value={draft.skills.join(", ")}
              onChange={(event) => {
                const skills = event.target.value.split(",").map((item) => item.trim()).filter(Boolean);
                setDraft((current) => ({ ...current, skills }));
              }}
              onBlur={() => saveAgent({ skills: draft.skills })}
            />
          </Field>
          <Field label="Default model">
            <Select value={draft.defaultModelRefId} onValueChange={(defaultModelRefId) => saveAgent({ defaultModelRefId })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {modelRefs.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label} ·{" "}
                      {providerConfigs.find((item) => item.id === model.providerConfigId)?.label ?? model.provider}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field label="System prompt">
            <Textarea
              value={draft.systemPrompt}
              onChange={(event) => setDraft((current) => ({ ...current, systemPrompt: event.target.value }))}
              onBlur={(event) => saveAgent({ systemPrompt: event.currentTarget.value })}
            />
          </Field>
          <ToggleRow label="Shared" checked={draft.shared} onCheckedChange={(shared) => saveAgent({ shared })} />
        </div>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader
          title="Prompt Templates"
          description="Templates appear in the chat command palette for this agent."
        />
        <div className="grid gap-3">
          {draft.promptTemplates.length > 0 ? (
            <div className="grid gap-2">
              {draft.promptTemplates.map((template) => (
                <div key={template.id} className="flex items-start gap-2 rounded-md border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{template.name}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{template.body}</div>
                  </div>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    title="Delete template"
                    onClick={() => deletePromptTemplate(template.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="grid gap-3 rounded-md border p-3">
            <Field label="Template name">
              <Input value={templateName} onChange={(event) => setTemplateName(event.target.value)} />
            </Field>
            <Field label="Template text">
              <Textarea value={templateBody} onChange={(event) => setTemplateBody(event.target.value)} />
            </Field>
            <div>
              <Button type="button" variant="secondary" onClick={addPromptTemplate}>
                <PlusIcon data-icon="inline-start" />
                Add template
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader
          title="Permissions"
          description="Read, write, and edit are enabled by default inside the working directory."
        />
        <div className="grid gap-2">
          {(Object.keys(draft.permissions) as Array<keyof AgentPermissions>).map((permission) => (
            <ToggleRow
              key={permission}
              label={permission}
              checked={draft.permissions[permission]}
              onCheckedChange={(checked) =>
                saveAgent({ permissions: { ...draft.permissions, [permission]: checked } })
              }
            />
          ))}
        </div>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader title="Danger Zone" description="Deleting an agent also deletes sessions that belong to it." />
        <div>
          <Button variant="destructive" onClick={() => void removeAgent()}>
            <Trash2Icon data-icon="inline-start" />
            Delete agent
          </Button>
        </div>
      </section>
    </div>
  );
}
