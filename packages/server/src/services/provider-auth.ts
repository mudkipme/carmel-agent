import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_OLLAMA_BASE_URL,
  getOllamaThinkingLevelMap,
  OLLAMA_PROVIDER,
  type ProviderModelSummary,
} from "@carmel-agent/shared";

export async function hasProviderAuth(modelRuntime: ModelRuntime, provider: string) {
  return isAuthOptionalProvider(provider) || Boolean(await modelRuntime.checkAuth(provider));
}

export async function ensureOptionalProviderAuth(
  modelRuntime: ModelRuntime,
  provider: string,
  baseUrl?: string,
) {
  if (!isAuthOptionalProvider(provider)) return;

  // Pi's ModelRuntime requires the provider to be registered before it can
  // prepare a request. Ollama is Carmel's OpenAI-compatible provider rather
  // than one of Pi's built-in providers, so register it with a placeholder
  // key (Ollama does not require authentication) and the configured endpoint.
  modelRuntime.registerProvider(provider, {
    name: "Ollama",
    baseUrl: baseUrl || DEFAULT_OLLAMA_BASE_URL,
    apiKey: "ollama",
    api: "openai-completions",
  });

  if (!(await modelRuntime.checkAuth(provider))) {
    await modelRuntime.setRuntimeApiKey(provider, "ollama");
  }
}

export async function listOllamaModels(baseUrl: string): Promise<ProviderModelSummary[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(resolveOllamaTagsUrl(baseUrl), { signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
    const payload = (await response.json()) as {
      models?: Array<{ name?: unknown; model?: unknown }>;
    };
    const modelIds = (payload.models ?? [])
      .map((model) => {
        const modelId =
          typeof model.name === "string"
            ? model.name
            : typeof model.model === "string"
              ? model.model
              : "";
        return modelId.trim();
      })
      .filter(Boolean);

    return modelIds.map((modelId) => ({
      id: modelId,
      name: modelId,
      api: "openai-completions" as const,
      input: ["text" as const],
      reasoning: true,
      thinkingLevelMap: getOllamaThinkingLevelMap(modelId),
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out connecting to Ollama.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveOllamaTagsUrl(baseUrl: string) {
  const url = new URL(baseUrl || DEFAULT_OLLAMA_BASE_URL);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${path}/api/tags`;
  url.search = "";
  url.hash = "";
  return url;
}

function isAuthOptionalProvider(provider: string) {
  return provider === OLLAMA_PROVIDER;
}
