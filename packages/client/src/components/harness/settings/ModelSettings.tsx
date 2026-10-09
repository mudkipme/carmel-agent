import { CheckIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { SectionHeader } from "@/components/harness/form-primitives";
import { Field, FieldLabel } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useModelManagement } from "@/hooks/use-model-management";
import { cn } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import type { ModelRef, ProviderConfig, ProviderModelSummary } from "@carmel-agent/shared";

export function ModelSettings({
  modelRefs,
  providerConfigs,
  fastTaskModelRefId,
  onFastTaskModelChange,
  onModelChange,
  updating,
  status,
}: {
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  fastTaskModelRefId: string;
  onFastTaskModelChange: (modelRefId: string) => void;
  onModelChange: (model: ModelRef) => void;
  updating: boolean;
  status: { tone: "muted" | "destructive"; message: string } | null;
}) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const management = useModelManagement(modelRefs, providerConfigs);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="grid min-w-0 gap-4">
        <SectionHeader
          title="Fast Task Model"
          description="Used for lightweight background tasks such as session title generation."
        />
        <Field>
          <FieldLabel>Model</FieldLabel>
          <Select
            value={fastTaskModelRefId || "__session_model__"}
            disabled={updating}
            onValueChange={(value) =>
              onFastTaskModelChange(value === "__session_model__" ? "" : value)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[calc(100vw-2rem)]">
              <SelectGroup>
                <SelectItem value="__session_model__">Use current session model</SelectItem>
                {modelRefs.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                    {model.shared ? " · shared" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </section>

      <section className="grid min-w-0 gap-4 border-t pt-6">
        <SectionHeader
          title="Model Management"
          description="Each provider config can have one entry per model."
        />
        <div className="grid gap-2">
          {modelRefs.map((model) => {
            const providerConfig = providerConfigs.find(
              (item) => item.id === model.providerConfigId,
            );
            const owned = model.ownerUserId === activeUserId;
            return (
              <div
                key={model.id}
                className="flex min-w-0 flex-col gap-3 rounded-md border bg-card p-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 truncate">
                    <span className="truncate text-sm font-medium">{model.label}</span>
                    {model.shared ? <Badge variant="secondary">shared</Badge> : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {providerConfig?.label ?? (owned ? model.provider : "Shared provider")} ·{" "}
                    {model.modelId}
                  </p>
                </div>
                {owned ? (
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant={model.shared ? "secondary" : "outline"}
                      size="sm"
                      disabled={updating}
                      onClick={() => onModelChange({ ...model, shared: !model.shared })}
                    >
                      {model.shared ? "Shared" : "Share"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void management.removeModel(model)}
                      title="Delete model"
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {status ? (
          <p
            className={cn(
              "text-sm",
              status.tone === "destructive" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {status.message}
          </p>
        ) : null}
      </section>

      <section className="grid min-w-0 gap-4 border-t pt-6">
        <SectionHeader
          title="Add Model"
          description="Adding an existing provider/model pair will reuse the existing entry."
        />
        <div className="grid gap-3">
          <Select
            value={management.providerConfigId}
            onValueChange={management.selectProviderConfig}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[calc(100vw-2rem)]">
              <SelectGroup>
                {providerConfigs.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label} · {item.provider}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <ModelPicker
            key={management.providerConfigId}
            models={management.providerModels}
            value={management.modelId}
            onValueChange={management.setModelId}
          />
          {management.isOllamaProvider ? (
            <Field>
              <FieldLabel>Model ID</FieldLabel>
              <Input
                value={management.modelId}
                placeholder="llama3.2:latest"
                onChange={(event) => management.setModelId(event.target.value)}
              />
            </Field>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => void management.loadProviderModels()}
            disabled={management.loadingProviderModels}
          >
            {management.loadingProviderModels ? "Refreshing..." : "Refresh models"}
          </Button>
          {management.providerModelsError ? (
            <p className="text-xs text-destructive">{management.providerModelsError}</p>
          ) : null}
          <Button
            onClick={() => void management.addModel()}
            disabled={!management.modelId.trim() || !management.selectedProviderConfig}
          >
            {management.existingModel ? "Already configured" : "Add model"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function ModelPicker({
  models,
  value,
  onValueChange,
}: {
  models: ProviderModelSummary[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedModel = models.find((model) => model.id === value);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = normalizedQuery
    ? models.filter(
        (model) =>
          model.name.toLowerCase().includes(normalizedQuery) ||
          model.id.toLowerCase().includes(normalizedQuery),
      )
    : models;

  return (
    <div className="grid min-w-0 gap-2">
      <div className="rounded-md border bg-background">
        <div className="flex h-9 min-w-0 items-center gap-2 border-b px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${models.length} models...`}
            className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {visibleModels.length > 0 ? (
            visibleModels.map((model) => (
              <button
                key={model.id}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => onValueChange(model.id)}
              >
                <CheckIcon
                  className={model.id === value ? "size-4 opacity-100" : "size-4 opacity-0"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{model.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{model.id}</span>
                </span>
              </button>
            ))
          ) : (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              No models found.
            </div>
          )}
        </div>
      </div>
      {selectedModel ? (
        <p className="truncate text-xs text-muted-foreground">
          Selected: {selectedModel.name} · {selectedModel.id}
        </p>
      ) : null}
    </div>
  );
}
