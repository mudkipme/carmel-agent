import {
  ArrowLeftIcon,
  CheckIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LogOutIcon,
  MonitorIcon,
  SearchIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, SectionHeader } from "@/components/harness/form-primitives";
import { api } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { setThemePreference, useThemePreference, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  defaultBaseUrlForProvider,
  getAppProviders,
  makeModelRef,
  modelsForProvider,
  useHarnessStore,
} from "@/store/harness-store";
import {
  OLLAMA_PROVIDER,
  type ModelRef,
  type OAuthLoginFlowState,
  type OAuthProviderSummary,
  type ProviderConfig,
  type ProviderModelSummary,
} from "@carmel-agent/shared";

const providers = getAppProviders();
const settingsSections = [
  { id: "models", label: "Models", icon: DatabaseIcon },
  { id: "providers", label: "Providers", icon: KeyRoundIcon },
  { id: "appearance", label: "Appearance", icon: MonitorIcon },
  { id: "account", label: "Account", icon: UserIcon },
] as const;
type SettingsSection = (typeof settingsSections)[number]["id"];

export function SettingsPage() {
  const navigate = useNavigate();
  const { section } = useParams();
  const activeSection = settingsSections.some((item) => item.id === section)
    ? (section as SettingsSection)
    : "models";
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const providerConfigs = useHarnessStore((state) => state.providerConfigs);
  const activeUser = useHarnessStore((state) => state.users.find((item) => item.id === state.activeUserId));
  const upsertUser = useHarnessStore((state) => state.upsertUser);
  const upsertModelRef = useHarnessStore((state) => state.upsertModelRef);
  const themePreference = useThemePreference();
  const [draftThemePreference, setDraftThemePreference] = useState<ThemePreference>(() => themePreference);
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderSummary[]>([]);
  const [modelStatus, setModelStatus] = useState<{ tone: "muted" | "destructive"; message: string } | null>(null);
  const [updatingModelSettings, setUpdatingModelSettings] = useState(false);
  const [appearanceSaveMessage, setAppearanceSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (section && !settingsSections.some((item) => item.id === section)) {
      navigate("/settings/models", { replace: true });
    }
  }, [navigate, section]);

  useEffect(() => {
    void api.getOAuthProviders().then(setOAuthProviders).catch(() => setOAuthProviders([]));
  }, []);

  const updateFastTaskModel = async (modelRefId: string) => {
    if (!activeUser) return;
    setUpdatingModelSettings(true);
    setModelStatus({ tone: "muted", message: "Saving fast task model..." });
    try {
      await upsertUser({
        ...activeUser,
        fastTaskModelRefId: modelRefId || undefined,
      });
      setModelStatus({ tone: "muted", message: "Fast task model saved." });
    } catch (error) {
      setModelStatus({
        tone: "destructive",
        message: error instanceof Error ? error.message : "Unable to save fast task model",
      });
    } finally {
      setUpdatingModelSettings(false);
    }
  };

  const updateModelSharing = async (model: ModelRef) => {
    setUpdatingModelSettings(true);
    setModelStatus({ tone: "muted", message: "Saving model sharing..." });
    try {
      await upsertModelRef(model);
      setModelStatus({ tone: "muted", message: "Model sharing saved." });
    } catch (error) {
      setModelStatus({
        tone: "destructive",
        message: error instanceof Error ? error.message : "Unable to save model sharing",
      });
    } finally {
      setUpdatingModelSettings(false);
    }
  };

  const saveAppearanceSettings = () => {
    setThemePreference(draftThemePreference);
    setAppearanceSaveMessage("Appearance saved.");
  };

  return (
    <main className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon-sm" title="Back to harness" onClick={() => navigate("/")}>
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium">Harness Settings</h1>
            <p className="truncate text-xs text-muted-foreground">Manage global provider and model settings.</p>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b bg-muted/35 p-2 md:w-56 md:border-r md:border-b-0">
          <nav className="grid grid-cols-2 gap-1 md:grid-cols-1">
            {settingsSections.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.id}
                  to={`/settings/${item.id}`}
                  className={({ isActive }) =>
                    cn(
                      "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                      isActive && "bg-accent text-accent-foreground",
                    )
                  }
                >
                  <Icon data-icon="inline-start" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
        </aside>
        <section className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-6">
            {activeSection === "models" ? (
              <ModelSettings
                modelRefs={modelRefs}
                providerConfigs={providerConfigs}
                fastTaskModelRefId={activeUser?.fastTaskModelRefId ?? ""}
                onFastTaskModelChange={(modelRefId) => void updateFastTaskModel(modelRefId)}
                onModelChange={(model) => void updateModelSharing(model)}
                updating={updatingModelSettings}
                status={modelStatus}
              />
            ) : null}
            {activeSection === "providers" ? (
              <ProviderSettings
                providerConfigs={providerConfigs}
                modelRefs={modelRefs}
                oauthProviders={oauthProviders}
              />
            ) : null}
            {activeSection === "appearance" ? (
              <AppearanceSettings
                value={draftThemePreference}
                onChange={(nextValue) => {
                  setDraftThemePreference(nextValue);
                  setAppearanceSaveMessage(null);
                }}
                onSave={saveAppearanceSettings}
                saveMessage={appearanceSaveMessage}
              />
            ) : null}
            {activeSection === "account" ? (
              <AccountSettings />
            ) : null}
          </div>
        </section>
      </div>
    </main>
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
  onSave,
  saveMessage,
}: {
  value: ThemePreference;
  onChange: (themePreference: ThemePreference) => void;
  onSave: () => void;
  saveMessage: string | null;
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
      {saveMessage ? <p className="text-sm text-muted-foreground">{saveMessage}</p> : null}
      <Button type="button" onClick={onSave}>
        Save appearance
      </Button>
    </div>
  );
}

function ModelSettings({
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
  const [selectedConfigId, setSelectedConfigId] = useState("new");
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
      baseUrl: baseUrl.trim() || defaultBaseUrlForProvider(provider) || undefined,
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
              const nextProvider = config?.provider ?? providers[0] ?? "openai";
              setProvider(nextProvider);
              setAuthType(config?.authType ?? "api_key");
              setLabel(config?.label ?? "");
              setBaseUrl(config?.baseUrl ?? defaultBaseUrlForProvider(nextProvider));
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
              const previousDefaultBaseUrl = defaultBaseUrlForProvider(provider);
              setProvider(nextProvider);
              if (!oauthProviders.some((item) => item.id === nextProvider)) setAuthType("api_key");
              if (!selectedConfig && (!baseUrl || baseUrl === previousDefaultBaseUrl)) {
                setBaseUrl(defaultBaseUrlForProvider(nextProvider));
              }
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
