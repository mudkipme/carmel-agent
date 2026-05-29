import { CheckIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Field, SectionHeader } from "@/components/harness/form-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { makeModelRef, modelsForProvider, useHarnessStore } from "@/store/harness-store";
import { OLLAMA_PROVIDER, type ModelRef, type ProviderConfig, type ProviderModelSummary } from "@carmel-agent/shared";
import { providers } from "./options";

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
  const upsertModelRef = useHarnessStore((state) => state.upsertModelRef);
  const deleteModelRef = useHarnessStore((state) => state.deleteModelRef);
  const [providerConfigId, setProviderConfigId] = useState(providerConfigs[0]?.id ?? "");
  const selectedProviderConfig = providerConfigs.find((item) => item.id === providerConfigId);
  const selectedProviderConfigRecordId = selectedProviderConfig?.id;
  const selectedProviderConfigProvider = selectedProviderConfig?.provider;
  const provider = selectedProviderConfig?.provider ?? providers[0] ?? "openai";
  const [providerModels, setProviderModels] = useState<ProviderModelSummary[]>([]);
  const [providerModelsError, setProviderModelsError] = useState("");
  const [loadingProviderModels, setLoadingProviderModels] = useState(false);
  const isOllamaProvider = selectedProviderConfig?.provider === OLLAMA_PROVIDER;
  const models: ProviderModelSummary[] = isOllamaProvider ? providerModels : modelsForProvider(provider);
  const [modelId, setModelId] = useState(modelsForProvider(provider)[0]?.id ?? "");
  const existingModel = modelRefs.find(
    (model) => model.providerConfigId === selectedProviderConfig?.id && model.modelId === modelId,
  );

  const loadProviderModels = async (providerConfig = selectedProviderConfig) => {
    if (!providerConfig || providerConfig.provider !== OLLAMA_PROVIDER) return;
    setLoadingProviderModels(true);
    setProviderModelsError("");
    try {
      const nextModels = await api.listProviderModels(providerConfig.id);
      setProviderModels(nextModels);
      setModelId((current) => current || (nextModels[0]?.id ?? ""));
    } catch (error) {
      setProviderModels([]);
      setProviderModelsError(error instanceof Error ? error.message : "Unable to load provider models");
    } finally {
      setLoadingProviderModels(false);
    }
  };

  useEffect(() => {
    if (!selectedProviderConfigRecordId || selectedProviderConfigProvider !== OLLAMA_PROVIDER) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      setLoadingProviderModels(true);
      setProviderModelsError("");
      try {
        const nextModels = await api.listProviderModels(selectedProviderConfigRecordId);
        if (cancelled) return;
        setProviderModels(nextModels);
        setModelId((current) => current || (nextModels[0]?.id ?? ""));
      } catch (error) {
        if (cancelled) return;
        setProviderModels([]);
        setProviderModelsError(error instanceof Error ? error.message : "Unable to load provider models");
      } finally {
        if (!cancelled) setLoadingProviderModels(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedProviderConfigRecordId, selectedProviderConfigProvider]);

  const addModel = async () => {
    if (existingModel) return;
    const trimmedModelId = modelId.trim();
    if (!trimmedModelId) return;
    const selectedModel = models.find((model) => model.id === trimmedModelId);
    const modelSummary =
      selectedModel ??
      (isOllamaProvider
        ? ({
            id: trimmedModelId,
            name: trimmedModelId,
            api: "openai-completions",
            input: ["text"],
          } satisfies ProviderModelSummary)
        : undefined);
    await upsertModelRef({
      ...makeModelRef(provider, trimmedModelId, selectedProviderConfig?.id, modelSummary),
      ownerUserId: activeUserId,
    });
  };

  const removeModel = async (model: ModelRef) => {
    const confirmed = window.confirm(`Delete ${model.label}? Agents and sessions using it will fall back automatically.`);
    if (!confirmed) return;
    try {
      await deleteModelRef(model.id);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to delete model");
    }
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        <SectionHeader
          title="Fast Task Model"
          description="Used for lightweight background tasks such as session title generation."
        />
        <Field label="Model">
          <Select
            value={fastTaskModelRefId || "__session_model__"}
            disabled={updating}
            onValueChange={(value) => onFastTaskModelChange(value === "__session_model__" ? "" : value)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
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

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader title="Model Management" description="Each provider config can have one entry per model." />
        <div className="grid gap-2">
          {modelRefs.map((model) => {
            const providerConfig = providerConfigs.find((item) => item.id === model.providerConfigId);
            const owned = model.ownerUserId === activeUserId;
            return (
              <div key={model.id} className="flex items-center justify-between gap-3 rounded-md border bg-card p-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 truncate">
                    <span className="truncate text-sm font-medium">{model.label}</span>
                    {model.shared ? <Badge variant="secondary">shared</Badge> : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {providerConfig?.label ?? (owned ? model.provider : "Shared provider")} · {model.modelId}
                  </p>
                </div>
                {owned ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant={model.shared ? "secondary" : "outline"}
                      size="sm"
                      disabled={updating}
                      onClick={() => onModelChange({ ...model, shared: !model.shared })}
                    >
                      {model.shared ? "Shared" : "Share"}
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => void removeModel(model)} title="Delete model">
                      <Trash2Icon />
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {status ? (
          <p className={cn("text-sm", status.tone === "destructive" ? "text-destructive" : "text-muted-foreground")}>
            {status.message}
          </p>
        ) : null}
      </section>

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader title="Add Model" description="Adding an existing provider/model pair will reuse the existing entry." />
        <div className="grid gap-3">
          <Select
            value={providerConfigId}
            onValueChange={(value) => {
              setProviderConfigId(value);
              const nextProvider = providerConfigs.find((item) => item.id === value)?.provider ?? providers[0] ?? "openai";
              setProviderModels([]);
              setProviderModelsError("");
              setModelId(nextProvider === OLLAMA_PROVIDER ? "" : (modelsForProvider(nextProvider)[0]?.id ?? ""));
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {providerConfigs.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label} · {item.provider}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <ModelPicker key={providerConfigId} models={models} value={modelId} onValueChange={setModelId} />
          {isOllamaProvider ? (
            <>
              <Field label="Model ID">
                <Input value={modelId} placeholder="llama3.2:latest" onChange={(event) => setModelId(event.target.value)} />
              </Field>
              <Button type="button" variant="outline" onClick={() => void loadProviderModels()} disabled={loadingProviderModels}>
                {loadingProviderModels ? "Refreshing..." : "Refresh models"}
              </Button>
              {providerModelsError ? <p className="text-xs text-destructive">{providerModelsError}</p> : null}
            </>
          ) : null}
          <Button onClick={() => void addModel()} disabled={!modelId.trim() || !selectedProviderConfig}>
            {existingModel ? "Already configured" : "Add model"}
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
    ? models.filter((model) => model.name.toLowerCase().includes(normalizedQuery) || model.id.toLowerCase().includes(normalizedQuery))
    : models;

  return (
    <div className="grid gap-2">
      <div className="rounded-md border bg-background">
        <div className="flex h-9 items-center gap-2 border-b px-3">
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
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => onValueChange(model.id)}
              >
                <CheckIcon className={model.id === value ? "size-4 opacity-100" : "size-4 opacity-0"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{model.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{model.id}</span>
                </span>
              </button>
            ))
          ) : (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">No models found.</div>
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
