import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { CheckIcon } from "lucide-react";
import type { AgentConfig } from "@carmel-agent/shared";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { agentColor, agentColorOptions, agentIconOptions } from "@/lib/agent-appearance";
import { AgentAvatar } from "../shell/AgentAvatar";

export function AgentAppearancePicker({
  agent,
  onChange,
}: {
  agent: AgentConfig;
  onChange: (patch: Partial<AgentConfig>) => void;
}) {
  const { i18n } = useLingui();
  return (
    <FieldGroup className="flex-row flex-wrap gap-4 sm:gap-6">
      <FieldSet className="w-auto gap-2">
        <FieldLegend variant="label">
          <Trans>Icon</Trans>
        </FieldLegend>
        <ToggleGroup
          type="single"
          spacing={1}
          value={agent.icon ?? "bot"}
          aria-label={i18n._("Agent icon")}
          className="grid grid-cols-6"
          onValueChange={(value) => {
            const option = agentIconOptions.find((option) => option.value === value);
            if (option) onChange({ icon: option.value });
          }}
        >
          {agentIconOptions.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              aria-label={i18n._(option.label)}
              title={i18n._(option.label)}
              className="size-10 p-0"
            >
              <AgentAvatar agent={{ ...agent, icon: option.value }} className="size-7" />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FieldSet>
      <FieldSet className="w-auto gap-2">
        <FieldLegend variant="label">
          <Trans>Color</Trans>
        </FieldLegend>
        <ToggleGroup
          type="single"
          spacing={1}
          value={agentColor(agent)}
          aria-label={i18n._("Agent color")}
          className="grid grid-cols-6"
          onValueChange={(value) => {
            const option = agentColorOptions.find((option) => option.value === value);
            if (option) onChange({ color: option.value });
          }}
        >
          {agentColorOptions.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              aria-label={i18n._(option.label)}
              title={i18n._(option.label)}
              className="size-10 p-0"
            >
              <span
                aria-hidden
                className="flex size-6 items-center justify-center rounded-full"
                style={{
                  backgroundColor: `var(--color-${option.value})`,
                  color: "var(--background)",
                }}
              >
                {agentColor(agent) === option.value ? <CheckIcon /> : null}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FieldSet>
    </FieldGroup>
  );
}
