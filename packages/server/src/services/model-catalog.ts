import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelsRefreshResult, ModelsStore } from "@earendil-works/pi-ai";
import {
  OLLAMA_PROVIDER,
  type ModelCatalog,
  type ProviderModelSummary,
} from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import { providerConfigs } from "../db/schema.ts";
import { createProviderConfigCredentialStore } from "../runtime/auth-storage.ts";
import { createCarmelModelRuntime } from "../runtime/model-runtime.ts";

type ProviderConfigRecord = typeof providerConfigs.$inferSelect;
type CatalogReadOptions = {
  allowNetwork?: boolean;
  catalogBaseUrl?: string;
  force?: boolean;
  modelsStore?: ModelsStore;
  timeoutMs?: number;
};

const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

export function readModelCatalog(): ModelCatalog {
  return {
    providers: Array.from(new Set([...getBuiltinProviders(), OLLAMA_PROVIDER])).map((id) => ({ id, name: id })),
  };
}

export async function readProviderModels(
  providerConfig: ProviderConfigRecord,
  options: CatalogReadOptions = {},
): Promise<ProviderModelSummary[]> {
  return (await refreshProviderModelCatalog(providerConfig, options)).models;
}

export async function refreshConfiguredModelCatalogs(): Promise<Map<string, Error>> {
  const errors = new Map<string, Error>();
  const configsByProvider = new Map<string, ProviderConfigRecord[]>();
  for (const config of db.select().from(providerConfigs).all()) {
    if (config.provider === OLLAMA_PROVIDER) continue;
    configsByProvider.set(config.provider, [...(configsByProvider.get(config.provider) ?? []), config]);
  }

  // Credential refresh may update SQLite. Keep provider refreshes sequential so
  // two expired OAuth credentials cannot open overlapping write transactions.
  for (const [provider, configs] of configsByProvider) {
    const config = configs.find((item) => item.apiKey || item.oauthCredential) ?? configs[0];
    if (!config) continue;
    try {
      const result = await refreshProviderModelCatalog(config, { allowNetwork: true });
      const error = result.refresh.errors.get(provider);
      if (error) errors.set(provider, error);
    } catch (error) {
      errors.set(provider, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

async function refreshProviderModelCatalog(
  providerConfig: ProviderConfigRecord,
  options: CatalogReadOptions,
): Promise<{ models: ProviderModelSummary[]; refresh: ModelsRefreshResult }> {
  const runtime = await createCarmelModelRuntime(
    createProviderConfigCredentialStore(providerConfig, providerConfig.provider),
    {
      allowModelNetwork: false,
      catalogBaseUrl: options.catalogBaseUrl,
      modelsStore: options.modelsStore,
    },
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
  const refresh = await runtime.refresh({
    allowNetwork: options.allowNetwork ?? true,
    force: options.force,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  return {
    models: runtime.getModels(providerConfig.provider).map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      input: model.input,
    })),
    refresh,
  };
}
