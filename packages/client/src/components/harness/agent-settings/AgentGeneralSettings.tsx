import { useLingui } from "@lingui/react";
import { thinkingLevelLabel } from "@/lib/labels";
import { Trans } from "@lingui/react/macro";
import { useId } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
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
import { AgentAvatar } from "../shell/AgentAvatar";
import { AgentAppearancePicker } from "./AgentAppearancePicker";
import type {
  AgentConfig,
  AgentMount,
  AgentThinkingLevel,
  ModelRef,
  ProviderConfig,
} from "@carmel-agent/shared";

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
  const { i18n } = useLingui();
  const fieldId = useId();
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
        <FieldGroup className="gap-4">
          <div className="flex items-end gap-3">
            <AgentAvatar agent={draft} className="size-12 rounded-xl" />
            <Field>
              <FieldLabel htmlFor={`${fieldId}-name`}>
                <Trans>Name</Trans>
              </FieldLabel>
              <Input
                id={`${fieldId}-name`}
                value={draft.name}
                onChange={(event) => onChange({ name: event.target.value })}
              />
            </Field>
          </div>
          <AgentAppearancePicker agent={draft} onChange={onChange} />
          <Field>
            <FieldLabel htmlFor={`${fieldId}-description`}>
              <Trans>Description</Trans>
            </FieldLabel>
            <Input
              id={`${fieldId}-description`}
              value={draft.description}
              onChange={(event) => onChange({ description: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-working-dir-mode`}>
              <Trans>Working dir</Trans>
            </FieldLabel>
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
                <SelectTrigger id={`${fieldId}-working-dir-mode`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="default">
                      <Trans>Default per-agent folder</Trans>
                    </SelectItem>
                    {canConfigureHostPaths ? (
                      <SelectItem value="manual">
                        <Trans>Manual server folder</Trans>
                      </SelectItem>
                    ) : null}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {canConfigureHostPaths && draft.workingDirMode === "manual" ? (
                <Input
                  aria-label={i18n._("Manual server folder")}
                  value={draft.workingDir}
                  onChange={(event) => onChange({ workingDir: event.target.value })}
                  placeholder="/path/on/server"
                />
              ) : null}
            </div>
          </Field>
          {canConfigureHostPaths ? (
            <FieldSet>
              <FieldLegend variant="label">
                <Trans>Extra runner mounts</Trans>
              </FieldLegend>
              <div className="grid gap-2">
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    Host directories mounted into the bash sandbox in addition to the workspace.
                    Source is a path on the host.
                  </Trans>
                </p>
                {draft.mounts.map((mount, index) => (
                  <FieldSet key={index} className="rounded-md border p-2">
                    <FieldLegend variant="label">
                      <Trans>Mount {index + 1}</Trans>
                    </FieldLegend>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor={`${fieldId}-mount-${index}-source`}>
                          <Trans>Host path</Trans>
                        </FieldLabel>
                        <div className="flex items-center gap-2">
                          <Input
                            id={`${fieldId}-mount-${index}-source`}
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
                            title={i18n._("Remove mount")}
                          >
                            <Trash2Icon className="size-4" />
                          </Button>
                        </div>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`${fieldId}-mount-${index}-target`}>
                          <Trans>Container path</Trans>
                        </FieldLabel>
                        <Input
                          id={`${fieldId}-mount-${index}-target`}
                          value={mount.target ?? ""}
                          onChange={(event) => updateMount(index, { target: event.target.value })}
                          placeholder={i18n._("Container path (defaults to source)")}
                        />
                      </Field>
                      <ToggleRow
                        label={i18n._("Read only")}
                        checked={mount.readOnly ?? false}
                        onCheckedChange={(readOnly) => updateMount(index, { readOnly })}
                      />
                    </FieldGroup>
                  </FieldSet>
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
                  <PlusIcon className="size-4" /> <Trans>Add mount</Trans>
                </Button>
              </div>
            </FieldSet>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${fieldId}-default-model`}>
              <Trans>Default model</Trans>
            </FieldLabel>
            <Select value={draft.defaultModelRefId} onValueChange={onSelectModel}>
              <SelectTrigger id={`${fieldId}-default-model`} className="w-full">
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
            <FieldLabel htmlFor={`${fieldId}-default-thinking`}>
              <Trans>Default thinking</Trans>
            </FieldLabel>
            <Select
              value={selectedThinkingLevel}
              onValueChange={(defaultThinkingLevel) =>
                onChange({ defaultThinkingLevel: defaultThinkingLevel as AgentThinkingLevel })
              }
            >
              <SelectTrigger id={`${fieldId}-default-thinking`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {thinkingLevels.map((level) => (
                    <SelectItem key={level} value={level}>
                      {thinkingLevelLabel(level)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-system-prompt`}>
              <Trans>System prompt</Trans>
            </FieldLabel>
            <Textarea
              id={`${fieldId}-system-prompt`}
              value={draft.systemPrompt}
              onChange={(event) => onChange({ systemPrompt: event.target.value })}
            />
          </Field>
          <ToggleRow
            label={i18n._("Shared")}
            checked={draft.shared}
            onCheckedChange={(shared) => onChange({ shared })}
          />
        </FieldGroup>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader
          title={i18n._("Danger Zone")}
          description={i18n._("Deleting an agent also deletes sessions that belong to it.")}
        />
        <div>
          <Button variant="destructive" onClick={onDelete}>
            <Trash2Icon data-icon="inline-start" />
            <Trans>Delete agent</Trans>
          </Button>
        </div>
      </section>
    </div>
  );
}
