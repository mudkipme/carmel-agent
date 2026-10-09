import {
  InMemoryCredentialStore,
  isModelType,
  type AnyModel,
  type Api,
  type CredentialStore,
  type Model,
  type ModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { modelCatalogStore } from "./model-store.ts";

type CarmelModelRuntimeOptions = Pick<
  CreateModelRuntimeOptions,
  "allowModelNetwork" | "catalogBaseUrl" | "modelRefreshTimeoutMs"
> & {
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

export function bindResolvedModel(runtime: ModelRuntime, model: Model<Api>): ModelRuntime {
  const isBound = (provider: string, modelId: string) =>
    provider === model.provider && modelId === model.id;
  const substitute = (models: readonly Model<Api>[]) =>
    models.map((candidate) => (isBound(candidate.provider, candidate.id) ? model : candidate));
  // A provider can now have chat, image and classifier entries with the same
  // ID. Only the chat entry belongs to this run's resolved configuration.
  const substituteAll = <T extends AnyModel>(models: readonly T[]): T[] =>
    models.map((candidate) =>
      isModelType(candidate, "chat") && isBound(candidate.provider, candidate.id)
        ? (model as unknown as T)
        : candidate,
    );
  const getModelOfType: ModelRuntime["getModelOfType"] = (type, provider, modelId) =>
    type === "chat" && isBound(provider, modelId)
      ? (model as ReturnType<typeof runtime.getModelOfType<typeof type>>)
      : runtime.getModelOfType(type, provider, modelId);
  const getModelsOfType: ModelRuntime["getModelsOfType"] = (type, provider) =>
    substituteAll(runtime.getModelsOfType(type, provider));
  const getAvailableOfType: ModelRuntime["getAvailableOfType"] = async (type, provider, options) =>
    substituteAll(await runtime.getAvailableOfType(type, provider, options));

  // A proxy rather than a subclass: ModelRuntime's own methods read private
  // fields, so every call this does not override has to run on the instance.
  return new Proxy(runtime, {
    get(target, property) {
      switch (property) {
        case "getModel":
        case "getPhysicalModel":
          return (provider: string, modelId: string) =>
            isBound(provider, modelId) ? model : target[property](provider, modelId);
        case "getModelOfType":
          return getModelOfType;
        case "getModelsOfType":
          return getModelsOfType;
        case "getAvailableOfType":
          return getAvailableOfType;
        case "getAllModels":
          return (provider?: string) => substituteAll(target.getAllModels(provider));
        case "getAllAvailable": {
          const getAllAvailable: ModelRuntime["getAllAvailable"] = async (provider, options) =>
            substituteAll(await target.getAllAvailable(provider, options));
          return getAllAvailable;
        }
        case "getModels":
          return (provider?: string) => substitute(target.getModels(provider));
        case "getAvailable": {
          const getAvailable: ModelRuntime["getAvailable"] = async (provider, options) =>
            substitute(await target.getAvailable(provider, options));
          return getAvailable;
        }
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
