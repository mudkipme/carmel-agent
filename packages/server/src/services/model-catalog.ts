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

/**
 * Serve the persisted catalog first and revalidate behind the response. Pi's
 * remote catalog lives on one host, so a blocked or slow request there stalled
 * the model picker for the whole refresh timeout. Pass `allowNetwork` or `force`
 * to wait for a live refresh instead.
 */
export async function readProviderModels(
  providerConfig: ProviderConfigRecord,
  options: CatalogReadOptions = {},
): Promise<ProviderModelSummary[]> {
  if (options.allowNetwork ?? options.force ?? false) {
    return (await refreshProviderModelCatalog(providerConfig, { ...options, allowNetwork: true })).models;
  }
  const { models } = await refreshProviderModelCatalog(providerConfig, { ...options, allowNetwork: false });
  // An explicit `allowNetwork: false` means offline, so only an unstated
  // preference (the model picker) gets the background revalidation.
  if (options.allowNetwork === undefined) queueCatalogRefresh(providerConfig, options);
  return models;
}

/** At most one in-flight revalidation per provider, so a burst of picker opens is one fetch. */
const backgroundRefreshes = new Map<string, Promise<unknown>>();

function queueCatalogRefresh(providerConfig: ProviderConfigRecord, options: CatalogReadOptions) {
  const provider = providerConfig.provider;
  if (backgroundRefreshes.has(provider)) return;
  const task = refreshProviderModelCatalog(providerConfig, { ...options, allowNetwork: true, force: false })
    // Nobody is waiting on this; the next read just keeps serving the cache.
    .catch(() => undefined)
    .finally(() => backgroundRefreshes.delete(provider));
  backgroundRefreshes.set(provider, task);
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
      // Carries which levels the provider actually accepts; dropping it caps the
      // thinking selector at "high" for models that support xhigh/max.
      thinkingLevelMap: model.thinkingLevelMap,
    })),
    refresh,
  };
}
