import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { CheckIcon } from "lucide-react";
import type { ModelRef, ProviderConfig } from "@carmel-agent/shared";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export function ModelCommandDialog({
  open,
  onOpenChange,
  modelRefs,
  providerConfigs,
  selectedModelRefId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  selectedModelRefId: string;
  onSelect: (modelRef: ModelRef) => void;
}) {
  const { i18n } = useLingui();
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={i18n._("Select Model")}
      description={i18n._("Select one of the models configured in settings.")}
      className="w-[calc(100vw-1.5rem)] max-w-md sm:max-w-lg"
    >
      <CommandInput placeholder={i18n._("Search configured models...")} />
      <CommandList>
        <CommandEmpty>
          <Trans>No configured models found.</Trans>
        </CommandEmpty>
        <CommandGroup heading={i18n._("Models")}>
          {modelRefs.map((configuredModel) => {
            const configuredProvider = providerConfigs.find(
              (item) => item.id === configuredModel.providerConfigId,
            );
            const selected = configuredModel.id === selectedModelRefId;
            const providerLabel = configuredProvider?.label ?? configuredModel.provider;
            return (
              <CommandItem
                key={configuredModel.id}
                value={`${configuredModel.label} ${providerLabel} ${configuredModel.modelId}`}
                className="min-w-0"
                onSelect={() => onSelect(configuredModel)}
              >
                <CheckIcon className={selected ? "opacity-100" : "opacity-0"} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{configuredModel.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {providerLabel} · {configuredModel.modelId}
                  </span>
                </div>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
