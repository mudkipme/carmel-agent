import { getProviders } from "@earendil-works/pi-ai";
import {
  DatabaseIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LogOutIcon,
  MonitorIcon,
  SettingsIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
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
import { Field, SectionHeader } from "@/components/harness/form-primitives";
import { api } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";
import { makeModelRef, modelsForProvider, useHarnessStore } from "@/store/harness-store";
import type { ModelRef, OAuthLoginFlowState, OAuthProviderSummary, ProviderConfig } from "@carmel-agent/shared";

const providers = getProviders();
const settingsDialogContentClass =
  "top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-3 text-[13px] sm:top-[50%] sm:left-[50%] sm:h-auto sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:p-6 sm:text-sm";
const settingsDialogBodyClass = "min-h-0 flex-1 overflow-y-auto pr-1";

export function SettingsDialog({
  modelRefs,
  providerConfigs,
}: {
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
}) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const upsertModelRef = useHarnessStore((state) => state.upsertModelRef);
  const themePreference = useThemePreference();
  const [open, setOpen] = useState(false);
  const [modelShareDrafts, setModelShareDrafts] = useState<Record<string, boolean>>({});
  const [draftThemePreference, setDraftThemePreference] = useState<ThemePreference>(themePreference);
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const draftModelRefs = modelRefs.map((model) =>
    Object.hasOwn(modelShareDrafts, model.id) ? { ...model, shared: modelShareDrafts[model.id] } : model,
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setModelShareDrafts({});
      setDraftThemePreference(themePreference);
      setSaveError(null);
    }
    setOpen(nextOpen);
  };

  useEffect(() => {
    if (!open) return;
    void api.getOAuthProviders().then(setOAuthProviders).catch(() => setOAuthProviders([]));
  }, [open]);

  const saveSettings = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const changedModels = draftModelRefs.filter((draftModel) => {
        const original = modelRefs.find((model) => model.id === draftModel.id);
        return original?.ownerUserId === activeUserId && original.shared !== draftModel.shared;
      });
      await Promise.all(changedModels.map((model) => upsertModelRef(model)));
      if (draftThemePreference !== themePreference) setThemePreference(draftThemePreference);
      setOpen(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon-sm">
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className={settingsDialogContentClass}>
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="text-base sm:text-lg">Harness Settings</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">Manage global provider and model settings.</DialogDescription>
        </DialogHeader>
        <div className={settingsDialogBodyClass}>
          <Tabs defaultValue="models" className="min-h-0">
            <TabsList className="!grid !h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4">
              <TabsTrigger value="models" className="h-8 text-xs sm:text-sm">
                <DatabaseIcon data-icon="inline-start" />
                Models
              </TabsTrigger>
              <TabsTrigger value="providers" className="h-8 text-xs sm:text-sm">
                <KeyRoundIcon data-icon="inline-start" />
                Providers
              </TabsTrigger>
              <TabsTrigger value="appearance" className="h-8 text-xs sm:text-sm">
                <MonitorIcon data-icon="inline-start" />
                Appearance
              </TabsTrigger>
              <TabsTrigger value="account" className="h-8 text-xs sm:text-sm">
                <UserIcon data-icon="inline-start" />
                Account
              </TabsTrigger>
            </TabsList>
            <TabsContent value="models" className="mt-2">
              <ModelSettings
                modelRefs={draftModelRefs}
                providerConfigs={providerConfigs}
                onModelChange={(model) =>
                  setModelShareDrafts((current) => ({ ...current, [model.id]: model.shared }))
                }
              />
            </TabsContent>
            <TabsContent value="providers" className="mt-2">
              <ProviderSettings
                providerConfigs={providerConfigs}
                modelRefs={modelRefs}
                oauthProviders={oauthProviders}
              />
            </TabsContent>
            <TabsContent value="appearance" className="mt-2">
              <AppearanceSettings value={draftThemePreference} onChange={setDraftThemePreference} />
            </TabsContent>
            <TabsContent value="account" className="mt-2">
              <AccountSettings />
            </TabsContent>
          </Tabs>
          {saveError ? <p className="mt-3 text-xs text-destructive sm:text-sm">{saveError}</p> : null}
        </div>
        <DialogFooter className="shrink-0 border-t pt-3 sm:border-0 sm:pt-0">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void saveSettings()} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountSettings() {
  const user = useHarnessStore((state) => state.users.find((item) => item.id === state.activeUserId));
  const changePassword = useHarnessStore((state) => state.changePassword);
  const logout = useHarnessStore((state) => state.logout);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const savePassword = async () => {
    setStatus(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setStatus("Password updated.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to update password.");
    }
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-4">
        <SectionHeader title="Account" description={user?.username ? `Signed in as ${user.username}.` : "Signed in."} />
        <Button variant="outline" onClick={() => void logout()}>
          <LogOutIcon data-icon="inline-start" />
          Sign out
        </Button>
      </section>
      <section className="grid gap-3 border-t pt-6">
        <SectionHeader title="Change Password" description="Update the password for this account." />
        <Field label="Current password">
          <Input
            value={currentPassword}
            type="password"
            autoComplete="current-password"
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field label="New password">
          <Input
            value={newPassword}
            type="password"
            autoComplete="new-password"
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Field>
        {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
        <Button onClick={() => void savePassword()} disabled={!currentPassword || newPassword.length < 8}>
          Update password
        </Button>
      </section>
    </div>
  );
}

function AppearanceSettings({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (themePreference: ThemePreference) => void;
}) {
  return (
    <div className="grid gap-4">
      <SectionHeader title="Appearance" description="Choose how Carmel Agent follows your display theme." />
      <Field label="Theme">
        <Select value={value} onValueChange={(nextValue) => onChange(nextValue as ThemePreference)}>
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
  onModelChange,
}: {
  modelRefs: ModelRef[];
  providerConfigs: ProviderConfig[];
  onModelChange: (model: ModelRef) => void;
}) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
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
    await upsertModelRef({
      ...makeModelRef(provider, modelId, selectedProviderConfig?.id),
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
                      onClick={() => onModelChange({ ...model, shared: !model.shared })}
                    >
                      {model.shared ? "Shared" : "Share"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void removeModel(model)}
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
  oauthProviders,
}: {
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  oauthProviders: OAuthProviderSummary[];
}) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const bootstrap = useHarnessStore((state) => state.bootstrap);
  const upsertProviderConfig = useHarnessStore((state) => state.upsertProviderConfig);
  const deleteProviderConfig = useHarnessStore((state) => state.deleteProviderConfig);
  const [selectedConfigId, setSelectedConfigId] = useState(providerConfigs[0]?.id ?? "new");
  const [provider, setProvider] = useState<string>(providers[0] ?? "openai");
  const [authType, setAuthType] = useState<"api_key" | "oauth">("api_key");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [oauthFlow, setOAuthFlow] = useState<OAuthLoginFlowState | null>(null);
  const [oauthInput, setOAuthInput] = useState("");
  const [saved, setSaved] = useState(false);
  const selectedConfig = providerConfigs.find((item) => item.id === selectedConfigId);
  const oauthProvider = oauthProviders.find((item) => item.id === provider);

  const save = async () => {
    await upsertProviderConfig({
      id: selectedConfig?.id ?? createClientId("provider"),
      userId: activeUserId,
      label: label.trim() || selectedConfig?.label || `${provider} config`,
      provider,
      authType,
      apiKey: authType === "api_key" ? apiKey || selectedConfig?.apiKey : undefined,
      baseUrl: baseUrl || undefined,
      customHeaders: selectedConfig?.customHeaders,
      createdAt: selectedConfig?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    setSelectedConfigId("new");
    setLabel("");
    setBaseUrl("");
    setApiKey("");
    setAuthType("api_key");
    setOAuthFlow(null);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  useEffect(() => {
    if (!oauthFlow || oauthFlow.status === "success" || oauthFlow.status === "error") return;
    const interval = window.setInterval(() => {
      void api.getOAuthLoginFlow(oauthFlow.id).then((flow) => {
        setOAuthFlow(flow);
        if (flow.status === "success") void bootstrap();
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [bootstrap, oauthFlow]);

  const startOAuthLogin = async () => {
    if (!selectedConfig) return;
    setOAuthInput("");
    const flow = await api.startProviderOAuthLogin(selectedConfig.id);
    setOAuthFlow(flow);
    if (flow.auth?.url) window.open(flow.auth.url, "_blank", "noopener,noreferrer");
  };

  const submitOAuthInput = async () => {
    if (!oauthFlow) return;
    const flow = await api.submitOAuthLoginFlowInput(oauthFlow.id, oauthInput);
    setOAuthInput("");
    setOAuthFlow(flow);
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
        setAuthType("api_key");
        setLabel("");
        setBaseUrl("");
        setApiKey("");
        setOAuthFlow(null);
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
                {item.baseUrl ?? "default endpoint"} ·{" "}
                {item.authType === "oauth" ? (item.hasOAuth ? "oauth connected" : "oauth not connected") : item.hasApiKey ? "key saved" : "no key"} ·{" "}
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
              setAuthType(config?.authType ?? "api_key");
              setLabel(config?.label ?? "");
              setBaseUrl(config?.baseUrl ?? "");
              setApiKey("");
              setOAuthFlow(null);
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
          <Select
            value={provider}
            onValueChange={(nextProvider) => {
              setProvider(nextProvider);
              if (!oauthProviders.some((item) => item.id === nextProvider)) setAuthType("api_key");
              setOAuthFlow(null);
            }}
          >
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
        <Field label="Authentication">
          <Select value={authType} onValueChange={(value) => setAuthType(value as "api_key" | "oauth")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="api_key">API key</SelectItem>
                {oauthProvider ? <SelectItem value="oauth">OAuth login</SelectItem> : null}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {authType === "api_key" ? (
          <Field label="API key">
            <Input value={apiKey} type="password" placeholder="API key" onChange={(event) => setApiKey(event.target.value)} />
          </Field>
        ) : (
          <div className="grid gap-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">{oauthProvider?.name ?? provider}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {selectedConfig?.hasOAuth ? "Connected" : "Not connected"}
                </div>
              </div>
              <Button type="button" variant="secondary" onClick={() => void startOAuthLogin()} disabled={!selectedConfig}>
                Login
              </Button>
            </div>
            {oauthFlow?.auth ? (
              <Button type="button" variant="outline" onClick={() => window.open(oauthFlow.auth?.url, "_blank", "noopener,noreferrer")}>
                <ExternalLinkIcon data-icon="inline-start" />
                Open login page
              </Button>
            ) : null}
            {oauthFlow?.auth?.instructions ? <p className="text-xs text-muted-foreground">{oauthFlow.auth.instructions}</p> : null}
            {oauthFlow?.progress ? <p className="text-xs text-muted-foreground">{oauthFlow.progress}</p> : null}
            {oauthFlow?.prompt ? (
              <div className="grid gap-2">
                <p className="text-xs text-muted-foreground">{oauthFlow.prompt.message}</p>
                {oauthFlow.prompt.kind === "select" ? (
                  <Select value={oauthInput} onValueChange={setOAuthInput}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {oauthFlow.prompt.options?.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={oauthInput}
                    placeholder={oauthFlow.prompt.placeholder}
                    onChange={(event) => setOAuthInput(event.target.value)}
                  />
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void submitOAuthInput()}
                  disabled={!oauthFlow.prompt.allowEmpty && !oauthInput}
                >
                  Continue
                </Button>
              </div>
            ) : null}
            {oauthFlow?.status === "success" ? <p className="text-xs text-muted-foreground">OAuth login completed.</p> : null}
            {oauthFlow?.error ? <p className="text-xs text-destructive">{oauthFlow.error}</p> : null}
            {!selectedConfig ? <p className="text-xs text-muted-foreground">Create the provider before logging in.</p> : null}
          </div>
        )}
        <Button onClick={() => void save()}>
          {saved ? "Saved" : selectedConfig ? "Update provider" : "Create provider"}
        </Button>
      </section>
    </div>
  );
}
