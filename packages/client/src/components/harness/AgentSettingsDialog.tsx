import { PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  fullscreenDialogContentClass,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import { api } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { cn } from "@/lib/utils";
import { resolveModelRef, useHarnessStore } from "@/store/harness-store";
import type {
  AgentConfig,
  AgentMount,
  AgentPermissions,
  AgentThinkingLevel,
  ModelRef,
  ProviderConfig,
} from "@carmel-agent/shared";

const agentSettingsDialogContentClass = fullscreenDialogContentClass("sm:max-w-lg");
const agentSettingsDialogBodyClass = "min-h-0 flex-1 overflow-y-auto pr-1";
const thinkingLevelLabels: Record<AgentThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Max",
};
const configurablePermissions: Array<keyof AgentPermissions> = ["read", "write", "edit", "bash", "network"];

export function AgentSettingsDialog({
  agent,
  modelRefs,
  providerConfigs,
  triggerClassName,
}: {
  agent: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  triggerClassName?: string;
}) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const [open, setOpen] = useState(false);
  const [settingsAgent, setSettingsAgent] = useState<AgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owned = agent.ownerUserId === activeUserId;

  useEffect(() => {
    if (!open || !owned) return;
    let cancelled = false;
    void api
      .getAgentSettings(agent.id)
      .then((payload) => {
        if (!cancelled) setSettingsAgent(payload);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load agent settings");
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, open, owned]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setSettingsAgent(null);
      setError(null);
    }
    setOpen(nextOpen);
  };

  if (!owned) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className={cn("coarse-pointer-visible shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100", triggerClassName)}
          title="Agent settings"
        >
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className={agentSettingsDialogContentClass}>
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="text-base sm:text-lg">Agent Settings</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            Configure this agent's workspace, prompt, model, and permissions.
          </DialogDescription>
        </DialogHeader>
        <div className={agentSettingsDialogBodyClass}>
          {error ? (
            <p className="text-xs text-destructive sm:text-sm">{error}</p>
          ) : settingsAgent ? (
            <AgentSettings
              key={settingsAgent.id}
              agent={settingsAgent}
              modelRefs={modelRefs}
              providerConfigs={providerConfigs}
              onClose={() => setOpen(false)}
            />
          ) : (
            <p className="text-xs text-muted-foreground sm:text-sm">Loading agent settings...</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentSettings({
  agent,
  modelRefs,
  providerConfigs,
  onClose,
}: {
  agent: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  onClose?: () => void;
}) {
  const upsertAgent = useHarnessStore((state) => state.upsertAgent);
  const deleteAgent = useHarnessStore((state) => state.deleteAgent);
  const [draft, setDraft] = useState(agent);
  const [templateName, setTemplateName] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const defaultModelRef = modelRefs.find((model) => model.id === draft.defaultModelRefId);
  const supportedThinkingLevels = useMemo<AgentThinkingLevel[]>(() => {
    if (!defaultModelRef) return ["off"];
    return getSupportedThinkingLevels(resolveModelRef(defaultModelRef)) as AgentThinkingLevel[];
  }, [defaultModelRef]);
  const selectedThinkingLevel = supportedThinkingLevels.includes(draft.defaultThinkingLevel)
    ? draft.defaultThinkingLevel
    : (supportedThinkingLevels[0] ?? "off");

  const updateDraft = (patch: Partial<AgentConfig>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const saveAgent = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await upsertAgent({ ...draft, defaultThinkingLevel: selectedThinkingLevel, updatedAt: Date.now() });
      onClose?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save agent");
    } finally {
      setSaving(false);
    }
  };

  const removeAgent = async () => {
    const confirmed = window.confirm(`Delete ${agent.name} and all of its sessions?`);
    if (!confirmed) return;
    try {
      await deleteAgent(agent.id);
      onClose?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to delete agent");
    }
  };

  const addPromptTemplate = () => {
    const name = templateName.trim();
    const body = templateBody.trim();
    if (!name || !body) return;
    updateDraft({
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
    updateDraft({
      promptTemplates: draft.promptTemplates.filter((template) => template.id !== templateId),
    });
  };

  const addMount = () => {
    updateDraft({ mounts: [...draft.mounts, { source: "", target: "", readOnly: false }] });
  };

  const updateMount = (index: number, patch: Partial<AgentMount>) => {
    updateDraft({
      mounts: draft.mounts.map((mount, mountIndex) => (mountIndex === index ? { ...mount, ...patch } : mount)),
    });
  };

  const removeMount = (index: number) => {
    updateDraft({ mounts: draft.mounts.filter((_, mountIndex) => mountIndex !== index) });
  };

  return (
    <div className="grid gap-4 sm:gap-6">
      <Tabs defaultValue="agent" className="w-full">
        <TabsList className="!grid !h-auto w-full grid-cols-3 gap-1">
          <TabsTrigger value="agent" className="h-8 text-xs sm:text-sm">Agent</TabsTrigger>
          <TabsTrigger value="templates" className="h-8 text-xs sm:text-sm">Templates</TabsTrigger>
          <TabsTrigger value="permissions" className="h-8 text-xs sm:text-sm">Permissions</TabsTrigger>
        </TabsList>

        <TabsContent value="agent" className="mt-2">
          <section className="grid gap-4">
            <SectionHeader title="Agent" description="Working directory, sharing, and system prompt." />
            <div className="grid gap-3">
              <Field label="Name">
                <Input
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </Field>
              <Field label="Working dir">
                <div className="grid gap-2">
                  <Select
                    value={draft.workingDirMode}
                    onValueChange={(workingDirMode: AgentConfig["workingDirMode"]) => {
                      const patch: Partial<AgentConfig> = { workingDirMode };
                      if (
                        workingDirMode === "manual" &&
                        draft.workingDirMode === "default" &&
                        draft.workingDir === draft.defaultWorkingDir
                      ) {
                        patch.workingDir = "";
                      }
                      updateDraft(patch);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="default">Default per-agent folder</SelectItem>
                        <SelectItem value="manual">Manual server folder</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {draft.workingDirMode === "manual" ? (
                    <Input
                      value={draft.workingDir}
                      onChange={(event) => setDraft((current) => ({ ...current, workingDir: event.target.value }))}
                      placeholder="/path/on/server"
                    />
                  ) : null}
                </div>
              </Field>
              <Field label="Extra runner mounts">
                <div className="grid gap-2">
                  <p className="text-xs text-muted-foreground">
                    Host directories mounted into the bash sandbox in addition to the workspace. Source is a path on the
                    host.
                  </p>
                  {draft.mounts.map((mount, index) => (
                    <div key={index} className="grid gap-2 rounded-md border p-2">
                      <div className="flex items-center gap-2">
                        <Input
                          value={mount.source}
                          onChange={(event) => updateMount(index, { source: event.target.value })}
                          placeholder="/host/path"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeMount(index)}
                          title="Remove mount"
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </div>
                      <Input
                        value={mount.target ?? ""}
                        onChange={(event) => updateMount(index, { target: event.target.value })}
                        placeholder="Container path (defaults to source)"
                      />
                      <ToggleRow
                        label="Read only"
                        checked={mount.readOnly ?? false}
                        onCheckedChange={(readOnly) => updateMount(index, { readOnly })}
                      />
                    </div>
                  ))}
                  <Button type="button" variant="outline" size="sm" onClick={addMount} className="justify-self-start">
                    <PlusIcon className="size-4" /> Add mount
                  </Button>
                </div>
              </Field>
              <Field label="Default model">
                <Select
                  value={draft.defaultModelRefId}
                  onValueChange={(defaultModelRefId) => {
                    const nextModelRef = modelRefs.find((model) => model.id === defaultModelRefId);
                    updateDraft({
                      defaultModelRefId,
                      defaultThinkingLevel: nextModelRef
                        ? (clampThinkingLevel(
                            resolveModelRef(nextModelRef),
                            draft.defaultThinkingLevel,
                          ) as AgentThinkingLevel)
                        : "off",
                    });
                  }}
                >
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
              <Field label="Default thinking">
                <Select
                  value={selectedThinkingLevel}
                  onValueChange={(defaultThinkingLevel) =>
                    updateDraft({ defaultThinkingLevel: defaultThinkingLevel as AgentThinkingLevel })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {supportedThinkingLevels.map((level) => (
                        <SelectItem key={level} value={level}>
                          {thinkingLevelLabels[level]}
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
                />
              </Field>
              <ToggleRow label="Shared" checked={draft.shared} onCheckedChange={(shared) => updateDraft({ shared })} />
            </div>
          </section>
        </TabsContent>

        <TabsContent value="templates" className="mt-2">
          <section className="grid gap-4">
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
        </TabsContent>

        <TabsContent value="permissions" className="mt-2">
          <section className="grid gap-4">
            <SectionHeader
              title="Permissions"
              description="Read, write, and edit are enabled by default inside the working directory."
            />
            <div className="grid gap-2">
              {configurablePermissions.map((permission) => (
                <ToggleRow
                  key={permission}
                  label={permission}
                  checked={draft.permissions[permission]}
                  onCheckedChange={(checked) =>
                    updateDraft({ permissions: { ...draft.permissions, [permission]: checked } })
                  }
                />
              ))}
            </div>
          </section>
        </TabsContent>
      </Tabs>

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader title="Danger Zone" description="Deleting an agent also deletes sessions that belong to it." />
        <div>
          <Button variant="destructive" onClick={() => void removeAgent()}>
            <Trash2Icon data-icon="inline-start" />
            Delete agent
          </Button>
        </div>
      </section>
      {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}
      <DialogFooter>
        <Button variant="outline" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void saveAgent()} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </DialogFooter>
    </div>
  );
}
