import { InMemoryCredentialStore, type Api, type CredentialStore, type Model, type ModelsStore } from "@earendil-works/pi-ai";
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

/**
 * Bind Carmel's resolved model configuration onto the runtime a run executes on.
 *
 * Pi 0.85 keeps only `{provider, modelId}` on the lane and resolves the model it
 * generates with by calling `models.getModel` again, so the `Model` handed to
 * `AgentHarness.create` is not what reaches the wire. Everything Carmel resolved
 * that the catalog entry does not carry -- the configured endpoint above all --
 * was dropped there, and requests went to the provider's default host instead.
 *
 * Making the lookup answer with the resolved model is also what keeps identity-
 * only lane reconciliation correct: two model configurations may share a
 * provider and model ID, and the run-scoped registry is what distinguishes them.
 */
export function bindResolvedModel(runtime: ModelRuntime, model: Model<Api>): ModelRuntime {
  const isBound = (provider: string, modelId: string) => provider === model.provider && modelId === model.id;
  const substitute = (models: readonly Model<Api>[]) =>
    models.map((candidate) => (isBound(candidate.provider, candidate.id) ? model : candidate));

  // A proxy rather than a subclass: ModelRuntime's own methods read private
  // fields, so every call this does not override has to run on the instance.
  return new Proxy(runtime, {
    get(target, property) {
      switch (property) {
        case "getModel":
          return (provider: string, modelId: string) =>
            isBound(provider, modelId) ? model : target.getModel(provider, modelId);
        case "getModels":
          return (provider?: string) => substitute(target.getModels(provider));
        case "getAvailable":
          return async (provider?: string) => substitute(await target.getAvailable(provider));
        case "getAvailableSnapshot":
          return () => substitute(target.getAvailableSnapshot());
        default: {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  });
}
