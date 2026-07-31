import { InMemoryCredentialStore, type CredentialStore, type ModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { modelCatalogStore } from "./model-store.ts";

type CarmelModelRuntimeOptions = Pick<CreateModelRuntimeOptions, "allowModelNetwork" | "catalogBaseUrl" | "modelRefreshTimeoutMs"> & {
  modelsStore?: ModelsStore;
};

export function createCarmelModelRuntime(
  credentials: CredentialStore = new InMemoryCredentialStore(),
  options: CarmelModelRuntimeOptions = {},
) {
  return ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: options.modelsStore ?? modelCatalogStore,
    allowModelNetwork: options.allowModelNetwork ?? false,
    catalogBaseUrl: options.catalogBaseUrl,
    modelRefreshTimeoutMs: options.modelRefreshTimeoutMs,
  });
}
