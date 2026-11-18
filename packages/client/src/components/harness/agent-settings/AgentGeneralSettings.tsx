import { useLingui } from "@lingui/react";
import { thinkingLevelLabel } from "@/lib/labels";
import { Trans } from "@lingui/react/macro";
import { useId } from "react";
import { Trash2Icon } from "lucide-react";
import { SectionHeader, ToggleRow } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { useHarnessStore } from "@/store/harness-store";
import { AgentAvatar } from "../shell/AgentAvatar";
import { AgentAppearancePicker } from "./AgentAppearancePicker";
import type {
  AgentConfig,
  AgentMount,
  AgentThinkingLevel,
  ModelRef,
  ProviderConfig,
} from "@carmel-agent/shared";

const defaultFolder = "__default__";

export function AgentGeneralSettings({
  draft,
  modelRefs,
  providerConfigs,
  thinkingLevels,
  selectedThinkingLevel,
  onChange,
  onSelectModel,
  onDelete,
}: {
  draft: AgentConfig;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  thinkingLevels: AgentThinkingLevel[];
  selectedThinkingLevel: AgentThinkingLevel;
  onChange: (patch: Partial<AgentConfig>) => void;
  onSelectModel: (modelRefId: string) => void;
  onDelete: () => void;
}) {
  const { i18n } = useLingui();
  const fieldId = useId();

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
          <WorkingFolderField
            id={`${fieldId}-working-folder`}
            environmentId={draft.environmentId}
            workingDir={draft.workingDir}
            onChange={(workingDir) => onChange({ workingDir })}
          />
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
          title={i18n._("Danger zone")}
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

/**
 * The agent's own folder under the environment's /workspace, or a folder inside
 * one of its mounts. Without mounts there is nothing to choose.
 */
function WorkingFolderField({
  id,
  environmentId,
  workingDir,
  onChange,
}: {
  id: string;
  environmentId: string;
  workingDir: string;
  onChange: (workingDir: string) => void;
}) {
  const { i18n } = useLingui();
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const environments = useRemoteResource({
    key: `environments:${activeUserId}`,
    load: (signal) => api.listEnvironments(signal),
    topics: ["workspace"],
  });
  const targets = (environments.data?.find((item) => item.id === environmentId)?.mounts ?? [])
    .map(mountTarget)
    .filter((target) => target !== "/");
  if (targets.length === 0 && !workingDir) return null;

  const mount = [...targets]
    .sort((left, right) => right.length - left.length)
    .find((target) => workingDir === target || workingDir.startsWith(`${target}/`));
  const subfolder = mount ? workingDir.slice(mount.length + 1) : "";

  return (
    <Field>
      <FieldLabel htmlFor={id}>
        <Trans>Working folder</Trans>
      </FieldLabel>
      <div className="grid gap-2">
        <Select
          value={mount ?? defaultFolder}
          onValueChange={(value) => onChange(value === defaultFolder ? "" : value)}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={defaultFolder}>
                <Trans>Default folder</Trans>
              </SelectItem>
              {targets.map((target) => (
                <SelectItem key={target} value={target}>
                  {target}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {mount ? (
          <Input
            aria-label={i18n._("Subfolder")}
            value={subfolder}
            onChange={(event) => {
              const path = event.target.value.replace(/^\/+/, "");
              onChange(path ? `${mount}/${path}` : mount);
            }}
            placeholder={i18n._("Subfolder")}
          />
        ) : null}
      </div>
    </Field>
  );
}

function mountTarget(mount: AgentMount) {
  return (mount.target?.trim() || mount.source.trim()).replace(/\/+$/, "") || "/";
}
