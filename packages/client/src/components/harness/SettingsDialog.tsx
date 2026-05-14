import { getProviders } from "@earendil-works/pi-ai";
import { DatabaseIcon, KeyRoundIcon, MonitorIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, SectionHeader } from "@/components/harness/form-primitives";
import { createClientId } from "@/lib/id";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";
import { makeModelRef, modelsForProvider, useHarnessStore } from "@/store/harness-store";
import type { ModelRef, ProviderConfig } from "@carmel-agent/shared";

const providers = getProviders();

export function SettingsDialog({
  modelRefs,
  providerConfigs,
}: {
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon-sm">
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Harness Settings</DialogTitle>
          <DialogDescription>Manage global provider and model settings.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="models">
          <TabsList>
            <TabsTrigger value="models">
              <DatabaseIcon data-icon="inline-start" />
              Models
            </TabsTrigger>
            <TabsTrigger value="providers">
              <KeyRoundIcon data-icon="inline-start" />
              Providers
            </TabsTrigger>
            <TabsTrigger value="appearance">
              <MonitorIcon data-icon="inline-start" />
              Appearance
            </TabsTrigger>
          </TabsList>
          <TabsContent value="models">
            <ModelSettings modelRefs={modelRefs} providerConfigs={providerConfigs} />
          </TabsContent>
          <TabsContent value="providers">
            <ProviderSettings providerConfigs={providerConfigs} modelRefs={modelRefs} />
          </TabsContent>
          <TabsContent value="appearance">
            <AppearanceSettings />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function AppearanceSettings() {
  const themePreference = useThemePreference();

  return (
    <div className="grid gap-4">
      <SectionHeader title="Appearance" description="Choose how Carmel Agent follows your display theme." />
      <Field label="Theme">
        <Select value={themePreference} onValueChange={(value) => setThemePreference(value as ThemePreference)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

function ModelSettings({
  modelRefs,
  providerConfigs,
}: {
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
}) {
  const upsertModelRef = useHarnessStore((state) => state.upsertModelRef);
  const deleteModelRef = useHarnessStore((state) => state.deleteModelRef);
  const [providerConfigId, setProviderConfigId] = useState(providerConfigs[0]?.id ?? "");
  const selectedProviderConfig = providerConfigs.find((item) => item.id === providerConfigId);
  const provider = selectedProviderConfig?.provider ?? providers[0] ?? "openai";
  const models = modelsForProvider(provider);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const existingModel = modelRefs.find(
    (model) => model.providerConfigId === selectedProviderConfig?.id && model.modelId === modelId,
  );

  const addModel = async () => {
    if (existingModel) return;
    await upsertModelRef(makeModelRef(provider, modelId, selectedProviderConfig?.id));
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
        <SectionHeader title="Model Management" description="Each provider config can have one entry per model." />
        <div className="grid gap-2">
          {modelRefs.map((model) => {
            const providerConfig = providerConfigs.find((item) => item.id === model.providerConfigId);
            return (
              <div key={model.id} className="flex items-center justify-between gap-3 rounded-md border bg-card p-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{model.label}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {providerConfig?.label ?? model.provider} · {model.modelId}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void removeModel(model)}
                  title="Delete model"
                >
                  <Trash2Icon />
                </Button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 border-t pt-6">
        <SectionHeader title="Add Model" description="Adding an existing provider/model pair will reuse the existing entry." />
        <div className="grid gap-3">
          <Select
            value={providerConfigId}
            onValueChange={(value) => {
              setProviderConfigId(value);
              const nextProvider = providerConfigs.find((item) => item.id === value)?.provider ?? providers[0] ?? "openai";
              setModelId(modelsForProvider(nextProvider)[0]?.id ?? "");
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
          <Select value={modelId} onValueChange={setModelId}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {models.slice(0, 80).map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button onClick={() => void addModel()} disabled={!modelId || !selectedProviderConfig}>
            {existingModel ? "Already configured" : "Add model"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function ProviderSettings({
  providerConfigs,
  modelRefs,
}: {
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
}) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const upsertProviderConfig = useHarnessStore((state) => state.upsertProviderConfig);
  const deleteProviderConfig = useHarnessStore((state) => state.deleteProviderConfig);
  const [selectedConfigId, setSelectedConfigId] = useState(providerConfigs[0]?.id ?? "new");
  const [provider, setProvider] = useState<string>(providers[0] ?? "openai");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const selectedConfig = providerConfigs.find((item) => item.id === selectedConfigId);

  const save = async () => {
    await upsertProviderConfig({
      id: selectedConfig?.id ?? createClientId("provider"),
      userId: activeUserId,
      label: label.trim() || selectedConfig?.label || `${provider} config`,
      provider,
      apiKey: apiKey || selectedConfig?.apiKey,
      baseUrl: baseUrl || undefined,
      customHeaders: selectedConfig?.customHeaders,
      createdAt: selectedConfig?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    setSelectedConfigId("new");
    setLabel("");
    setBaseUrl("");
    setApiKey("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const removeProviderConfig = async (providerConfig: ProviderConfig) => {
    const relatedModels = modelRefs.filter((model) => model.providerConfigId === providerConfig.id);
    const confirmed = window.confirm(
      `Delete ${providerConfig.label} and its ${relatedModels.length} model entries? Agents and sessions using them will fall back automatically.`,
    );
    if (!confirmed) return;
    try {
      await deleteProviderConfig(providerConfig.id);
      if (selectedConfigId === providerConfig.id) {
        setSelectedConfigId("new");
        setProvider(providers[0] ?? "openai");
        setLabel("");
        setBaseUrl("");
        setApiKey("");
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to delete provider config");
    }
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        <SectionHeader
          title="Provider Configs"
          description="Each config can have its own provider type, API key, and base URL."
        />
        <div className="grid gap-2">
          {providerConfigs.map((item) => {
            const relatedModels = modelRefs.filter((model) => model.providerConfigId === item.id);
            return (
            <div key={item.id} className="rounded-md border bg-card p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{item.label}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Badge variant="secondary">{item.provider}</Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="Delete provider config"
                    onClick={() => void removeProviderConfig(item)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {item.baseUrl ?? "default endpoint"} · {item.hasApiKey ? "key saved" : "no key"} ·{" "}
                {relatedModels.length} models
              </p>
            </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3 border-t pt-6">
        <Field label="Provider config">
          <Select
            value={selectedConfigId}
            onValueChange={(value) => {
              setSelectedConfigId(value);
              const config = providerConfigs.find((item) => item.id === value);
              setProvider(config?.provider ?? providers[0] ?? "openai");
              setLabel(config?.label ?? "");
              setBaseUrl(config?.baseUrl ?? "");
              setApiKey("");
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="new">New provider config</SelectItem>
                {providerConfigs.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Provider type">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {providers.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Label">
          <Input value={label} placeholder="Provider label" onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="Base URL">
          <Input value={baseUrl} placeholder="Optional API base URL" onChange={(event) => setBaseUrl(event.target.value)} />
        </Field>
        <Field label="API key">
          <Input value={apiKey} type="password" placeholder="API key" onChange={(event) => setApiKey(event.target.value)} />
        </Field>
        <Button onClick={() => void save()}>
          {saved ? "Saved" : selectedConfig ? "Update provider" : "Create provider"}
        </Button>
      </section>
    </div>
  );
}
