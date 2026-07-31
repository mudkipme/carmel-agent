import { useState } from "react";
import type { ModelRef, OAuthProviderSummary, ProviderConfig } from "@carmel-agent/shared";
import { confirmAction } from "@/lib/action-dialogs";
import { createClientId } from "@/lib/id";
import { showError } from "@/lib/errors";
import { defaultBaseUrlForProvider, getAppProviders, useHarnessStore } from "@/store/harness-store";
import { useProviderOAuth } from "./use-provider-oauth";

export function useProviderConfigEditor(
  providerConfigs: ProviderConfig[],
  modelRefs: ModelRef[],
  oauthProviders: OAuthProviderSummary[],
) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const modelCatalog = useHarnessStore((state) => state.modelCatalog);
  const upsertProviderConfig = useHarnessStore((state) => state.upsertProviderConfig);
  const deleteProviderConfig = useHarnessStore((state) => state.deleteProviderConfig);
  const providers = getAppProviders(modelCatalog);
  const [selectedConfigId, setSelectedConfigId] = useState("new");
  const [provider, setProvider] = useState(providers[0] ?? "openai");
  const [authType, setAuthType] = useState<"api_key" | "oauth">("api_key");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const selectedConfig = providerConfigs.find((item) => item.id === selectedConfigId);
  const oauthProvider = oauthProviders.find((item) => item.id === provider);
  const oauth = useProviderOAuth(selectedConfig);

  const resetEditor = () => {
    setSelectedConfigId("new");
    setProvider(providers[0] ?? "openai");
    setAuthType("api_key");
    setLabel("");
    setBaseUrl("");
    setApiKey("");
    oauth.reset();
  };

  const selectConfig = (id: string) => {
    const config = providerConfigs.find((item) => item.id === id);
    const nextProvider = config?.provider ?? providers[0] ?? "openai";
    setSelectedConfigId(id);
    setProvider(nextProvider);
    setAuthType(config?.authType ?? "api_key");
    setLabel(config?.label ?? "");
    setBaseUrl(config?.baseUrl ?? defaultBaseUrlForProvider(nextProvider));
    setApiKey("");
    oauth.reset();
  };

  const selectProvider = (nextProvider: string) => {
    const previousDefaultBaseUrl = defaultBaseUrlForProvider(provider);
    setProvider(nextProvider);
    if (!oauthProviders.some((item) => item.id === nextProvider)) setAuthType("api_key");
    if (!selectedConfig && (!baseUrl || baseUrl === previousDefaultBaseUrl)) {
      setBaseUrl(defaultBaseUrlForProvider(nextProvider));
    }
    oauth.reset();
  };

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
    resetEditor();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const remove = async (config: ProviderConfig) => {
    const relatedModels = modelRefs.filter((model) => model.providerConfigId === config.id);
    const confirmed = await confirmAction({
      title: `Delete ${config.label}?`,
      description: `This also removes ${relatedModels.length} model entries. Affected agents and sessions will fall back automatically.`,
      actionLabel: "Delete provider",
    });
    if (!confirmed) return;
    try {
      await deleteProviderConfig(config.id);
      if (selectedConfigId === config.id) resetEditor();
    } catch (error) {
      showError("Unable to delete provider config", error);
    }
  };

  return {
    providers,
    selectedConfigId,
    selectedConfig,
    provider,
    authType,
    setAuthType,
    label,
    setLabel,
    baseUrl,
    setBaseUrl,
    apiKey,
    setApiKey,
    saved,
    oauthProvider,
    oauth,
    selectConfig,
    selectProvider,
    save,
    remove,
  };
}
