import { PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Field, SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import { api } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { cn } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, AgentPermissions, AgentSkillCommand, ModelRef, ProviderConfig } from "@carmel-agent/shared";

const agentSettingsDialogContentClass =
  "top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-3 text-[13px] sm:top-[50%] sm:left-[50%] sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:p-6 sm:text-sm";
const agentSettingsDialogBodyClass = "min-h-0 flex-1 overflow-y-auto pr-1";

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
          size="icon-xs"
          variant="ghost"
          className={cn("shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100", triggerClassName)}
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
  const [availableSkills, setAvailableSkills] = useState<AgentSkillCommand[]>([]);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getGlobalSkills()
      .then((skills) => {
        if (!cancelled) setAvailableSkills(skills);
      })
      .catch((error: unknown) => {
        if (!cancelled) setSkillsError(error instanceof Error ? error.message : "Unable to load global skills");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateDraft = (patch: Partial<AgentConfig>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const saveAgent = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await upsertAgent({ ...draft, updatedAt: Date.now() });
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

  const toggleSkill = (skillName: string) => {
    updateDraft({
      skills: draft.skills.includes(skillName)
        ? draft.skills.filter((selectedSkill) => selectedSkill !== skillName)
        : [...draft.skills, skillName],
    });
  };

  const unavailableSelectedSkills = draft.skills.filter(
    (skillName) => !availableSkills.some((skill) => skill.name === skillName),
  );

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
            <SectionHeader title="Agent" description="Working directory, sharing, global skills, and system prompt." />
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
              <Field label="Global skills">
                <div className="grid gap-2">
                  <div className="grid max-h-56 gap-2 overflow-y-auto rounded-md border p-2">
                    {availableSkills.map((skill) => {
                      const selected = draft.skills.includes(skill.name);
                      return (
                        <button
                          key={skill.filePath}
                          type="button"
                          className="flex min-w-0 items-start justify-between gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          onClick={() => toggleSkill(skill.name)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{skill.name}</span>
                            <span className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                              {skill.description}
                            </span>
                          </span>
                          {selected ? <Badge variant="secondary">Selected</Badge> : null}
                        </button>
                      );
                    })}
                    {availableSkills.length === 0 ? (
                      <p className="px-2 py-1 text-sm text-muted-foreground">
                        {skillsError ?? "No global skills found."}
                      </p>
                    ) : null}
                  </div>
                  {unavailableSelectedSkills.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {unavailableSelectedSkills.map((skillName) => (
                        <Button
                          key={skillName}
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => toggleSkill(skillName)}
                          title="Remove unavailable skill"
                        >
                          {skillName}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </Field>
              <Field label="Default model">
                <Select
                  value={draft.defaultModelRefId}
                  onValueChange={(defaultModelRefId) => updateDraft({ defaultModelRefId })}
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
              {(Object.keys(draft.permissions) as Array<keyof AgentPermissions>).map((permission) => (
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
