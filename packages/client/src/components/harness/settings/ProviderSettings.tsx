import { ExternalLinkIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { Field, SectionHeader } from "@/components/harness/form-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { createClientId } from "@/lib/id";
import { defaultBaseUrlForProvider, useHarnessStore } from "@/store/harness-store";
import type { ModelRef, OAuthLoginFlowState, OAuthProviderSummary, ProviderConfig } from "@carmel-agent/shared";
import { providers } from "./options";

export function ProviderSettings({
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
                  {item.authType === "oauth"
                    ? item.hasOAuth
                      ? "oauth connected"
                      : "oauth not connected"
                    : item.hasApiKey
                      ? "key saved"
                      : "no key"}{" "}
                  · {relatedModels.length} models
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
        <Button onClick={() => void save()}>{saved ? "Saved" : selectedConfig ? "Update provider" : "Create provider"}</Button>
      </section>
    </div>
  );
}
