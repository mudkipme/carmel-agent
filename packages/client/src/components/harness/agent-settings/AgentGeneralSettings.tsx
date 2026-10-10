import { PlusIcon, Trash2Icon } from "lucide-react";
import { SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
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
import type {
  AgentConfig,
  AgentMount,
  AgentThinkingLevel,
  ModelRef,
  ProviderConfig,
} from "@carmel-agent/shared";

const thinkingLevelLabels: Record<AgentThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export function AgentGeneralSettings({
  draft,
  modelRefs,
  providerConfigs,
  canConfigureHostPaths,
  thinkingLevels,
  selectedThinkingLevel,
  onChange,
  onSelectModel,
  onDelete,
}: {
  draft: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  canConfigureHostPaths: boolean;
  thinkingLevels: AgentThinkingLevel[];
  selectedThinkingLevel: AgentThinkingLevel;
  onChange: (patch: Partial<AgentConfig>) => void;
  onSelectModel: (modelRefId: string) => void;
  onDelete: () => void;
}) {
  const updateMount = (index: number, patch: Partial<AgentMount>) => {
    onChange({
      mounts: draft.mounts.map((mount, mountIndex) =>
        mountIndex === index ? { ...mount, ...patch } : mount,
      ),
    });
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        <SectionHeader title="Agent" />
        <div className="grid gap-3">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={draft.name}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <Input
              value={draft.description}
              onChange={(event) => onChange({ description: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel>Working dir</FieldLabel>
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
                  onChange(patch);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="default">Default per-agent folder</SelectItem>
                    {canConfigureHostPaths ? (
                      <SelectItem value="manual">Manual server folder</SelectItem>
                    ) : null}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {canConfigureHostPaths && draft.workingDirMode === "manual" ? (
                <Input
                  value={draft.workingDir}
                  onChange={(event) => onChange({ workingDir: event.target.value })}
                  placeholder="/path/on/server"
                />
              ) : null}
            </div>
          </Field>
          {canConfigureHostPaths ? (
            <Field>
              <FieldLabel>Extra runner mounts</FieldLabel>
              <div className="grid gap-2">
                <p className="text-xs text-muted-foreground">
                  Host directories mounted into the bash sandbox in addition to the workspace.
                  Source is a path on the host.
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
                        onClick={() =>
                          onChange({ mounts: draft.mounts.filter((_, at) => at !== index) })
                        }
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onChange({
                      mounts: [...draft.mounts, { source: "", target: "", readOnly: false }],
                    })
                  }
                  className="justify-self-start"
                >
                  <PlusIcon className="size-4" /> Add mount
                </Button>
              </div>
            </Field>
          ) : null}
          <Field>
            <FieldLabel>Default model</FieldLabel>
            <Select value={draft.defaultModelRefId} onValueChange={onSelectModel}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {modelRefs.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label} ·{" "}
                      {providerConfigs.find((item) => item.id === model.providerConfigId)?.label ??
                        model.provider}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Default thinking</FieldLabel>
            <Select
              value={selectedThinkingLevel}
              onValueChange={(defaultThinkingLevel) =>
                onChange({ defaultThinkingLevel: defaultThinkingLevel as AgentThinkingLevel })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {thinkingLevels.map((level) => (
                    <SelectItem key={level} value={level}>
                      {thinkingLevelLabels[level]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>System prompt</FieldLabel>
            <Textarea
              value={draft.systemPrompt}
              onChange={(event) => onChange({ systemPrompt: event.target.value })}
            />
          </Field>
          <ToggleRow
            label="Shared"
            checked={draft.shared}
            onCheckedChange={(shared) => onChange({ shared })}
          />
        </div>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader
          title="Danger Zone"
          description="Deleting an agent also deletes sessions that belong to it."
        />
        <div>
          <Button variant="destructive" onClick={onDelete}>
            <Trash2Icon data-icon="inline-start" />
            Delete agent
          </Button>
        </div>
      </section>
    </div>
  );
}
