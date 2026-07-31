import { useEffect, useState } from "react";
import { OLLAMA_PROVIDER, type ModelRef, type ProviderConfig, type ProviderModelSummary } from "@carmel-agent/shared";
import { api } from "@/lib/api";
import { confirmAction } from "@/lib/action-dialogs";
import { showError } from "@/lib/errors";
import { getAppProviders, makeModelRef, useHarnessStore } from "@/store/harness-store";

export function useModelManagement(modelRefs: ModelRef[], providerConfigs: ProviderConfig[]) {
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const modelCatalog = useHarnessStore((state) => state.modelCatalog);
  const upsertModelRef = useHarnessStore((state) => state.upsertModelRef);
  const deleteModelRef = useHarnessStore((state) => state.deleteModelRef);
  const [providerConfigId, setProviderConfigId] = useState(providerConfigs[0]?.id ?? "");
  const [providerModels, setProviderModels] = useState<ProviderModelSummary[]>([]);
  const [providerModelsError, setProviderModelsError] = useState("");
  const [loadingProviderModels, setLoadingProviderModels] = useState(false);
  const [modelId, setModelId] = useState("");
  const selectedProviderConfig = providerConfigs.find((item) => item.id === providerConfigId);
  const provider = selectedProviderConfig?.provider ?? getAppProviders(modelCatalog)[0] ?? "openai";
  const selectedProviderConfigRecordId = selectedProviderConfig?.id;
  const isOllamaProvider = provider === OLLAMA_PROVIDER;
  const existingModel = modelRefs.find(
    (model) => model.providerConfigId === selectedProviderConfig?.id && model.modelId === modelId,
  );

  const loadProviderModels = async (providerConfig = selectedProviderConfig) => {
    if (!providerConfig) return;
    setLoadingProviderModels(true);
    setProviderModelsError("");
    try {
      const models = await api.listProviderModels(providerConfig.id);
      setProviderModels(models);
      setModelId((current) => current || (models[0]?.id ?? ""));
    } catch (error) {
      setProviderModels([]);
      setProviderModelsError(error instanceof Error ? error.message : "Unable to load provider models");
    } finally {
      setLoadingProviderModels(false);
    }
  };

  useEffect(() => {
    if (!selectedProviderConfigRecordId) return;
    let cancelled = false;
    setLoadingProviderModels(true);
    setProviderModelsError("");
    void api.listProviderModels(selectedProviderConfigRecordId).then(
      (models) => {
        if (cancelled) return;
        setProviderModels(models);
        setModelId((current) => current || (models[0]?.id ?? ""));
        setLoadingProviderModels(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setProviderModels([]);
        setProviderModelsError(error instanceof Error ? error.message : "Unable to load provider models");
        setLoadingProviderModels(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedProviderConfigRecordId, provider]);

  const selectProviderConfig = (id: string) => {
    setProviderConfigId(id);
    setProviderModels([]);
    setProviderModelsError("");
    setModelId("");
  };

  const addModel = async () => {
    const trimmedModelId = modelId.trim();
    if (existingModel || !trimmedModelId || !selectedProviderConfig) return;
    const selectedModel = providerModels.find((model) => model.id === trimmedModelId);
    const summary = selectedModel ?? ({
      id: trimmedModelId,
      name: trimmedModelId,
      api: isOllamaProvider ? "openai-completions" : undefined,
      input: ["text"],
    } satisfies ProviderModelSummary);
    await upsertModelRef({
      ...makeModelRef(provider, trimmedModelId, selectedProviderConfig.id, summary),
      ownerUserId: activeUserId,
    });
  };

  const removeModel = async (model: ModelRef) => {
    const confirmed = await confirmAction({
      title: `Delete ${model.label}?`,
      description: "Agents and sessions using it will fall back to another available model.",
      actionLabel: "Delete model",
    });
    if (!confirmed) return;
    try {
      await deleteModelRef(model.id);
    } catch (error) {
      showError("Unable to delete model", error);
    }
  };

  return {
    providerConfigId,
    providerModels,
    providerModelsError,
    loadingProviderModels,
    modelId,
    setModelId,
    selectedProviderConfig,
    isOllamaProvider,
    existingModel,
    selectProviderConfig,
    loadProviderModels,
    addModel,
    removeModel,
  };
}
