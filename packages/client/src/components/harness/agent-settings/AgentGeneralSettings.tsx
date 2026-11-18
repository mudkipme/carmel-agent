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
import { AgentAvatar } from "../shell/AgentAvatar";
import { AgentAppearancePicker } from "./AgentAppearancePicker";
import type {
  AgentConfig,
  AgentThinkingLevel,
  ModelRef,
  ProviderConfig,
} from "@carmel-agent/shared";

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
