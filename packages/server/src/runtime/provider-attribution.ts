import type { Api, Model, ModelsApiStreamOptions, ModelsSimpleStreamOptions, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Pi's provider attribution headers, ported from `pi-coding-agent`.
 *
 * The headers a provider uses to tell *which client* is calling live in
 * `pi-coding-agent/core/provider-attribution`, not in `pi-ai` -- so they ride
 * along with the CLI, and a harness built on `pi-agent-core` + `pi-ai` (which
 * is what Carmel is) sends none of them. OpenRouter attributes a request to an
 * app by `HTTP-Referer`/`X-OpenRouter-Title`, so without these every Carmel run
 * lands in its dashboard as "unknown".
 *
 * The `User-Agent` is *not* part of this: `pi-ai` already stamps every request
 * with `pi (<platform> <release>; <arch>)` from its own `getPiUserAgent`, so it
 * matches the CLI byte for byte as long as the two run the same SDK version.
 *
 * Kept as a transcription rather than an import because `pi-coding-agent` gates
 * it behind a `SettingsManager` Carmel does not construct. Values below must
 * stay identical to the CLI's -- re-check them when bumping pi.
 */

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string, expectedHost: string) {
  try {
    return new URL(baseUrl).hostname === expectedHost;
  } catch {
    return false;
  }
}

function isOpenRouterModel(model: Model<Api>) {
  return model.provider === "openrouter" || model.baseUrl.includes(OPENROUTER_HOST);
}

function isNvidiaNimModel(model: Model<Api>) {
  return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

function isCloudflareModel(model: Model<Api>) {
  return (
    model.provider === "cloudflare-workers-ai" ||
    model.provider === "cloudflare-ai-gateway" ||
    matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
    matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
  );
}

/**
 * Pi's opt-out, honoured under pi's own name because that is the switch a
 * reader already knows -- the same reasoning as `PI_CACHE_RETENTION` in env.ts.
 * The CLI's stored setting defaults to enabled, so an unset env means "send".
 */
function isAttributionEnabled(telemetryEnv = process.env.PI_TELEMETRY) {
  if (telemetryEnv === undefined) return true;
  const normalized = telemetryEnv.toLowerCase();
  return telemetryEnv === "1" || normalized === "true" || normalized === "yes";
}

function defaultAttributionHeaders(model: Model<Api>): ProviderHeaders | undefined {
  if (!isAttributionEnabled()) return undefined;

  if (isOpenRouterModel(model)) {
    return {
      "HTTP-Referer": "https://pi.dev",
      "X-OpenRouter-Title": "pi",
      "X-OpenRouter-Categories": "cli-agent",
    };
  }
  if (isNvidiaNimModel(model)) {
    return { "X-BILLING-INVOKE-ORIGIN": "Pi" };
  }
  if (isCloudflareModel(model)) {
    return { "User-Agent": "pi-coding-agent" };
  }
  return undefined;
}

function sessionHeaders(model: Model<Api>, sessionId: string | undefined): ProviderHeaders | undefined {
  if (!sessionId) return undefined;
  if (
    model.provider !== "opencode" &&
    model.provider !== "opencode-go" &&
    !matchesHost(model.baseUrl, OPENCODE_HOST)
  ) {
    return undefined;
  }
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

/**
 * Attribution first, caller headers last: auth and per-request headers must win,
 * which is the order the CLI merges in.
 */
export function mergeProviderAttributionHeaders(
  model: Model<Api>,
  sessionId: string | undefined,
  ...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
  const merged: ProviderHeaders = {
    ...sessionHeaders(model, sessionId),
    ...defaultAttributionHeaders(model),
  };
  for (const headers of headerSources) {
    if (headers) Object.assign(merged, headers);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Attach attribution to every generation the harness drives off this runtime.
 *
 * `transformHeaders` is the same seam the CLI uses, and it runs after `pi-ai`
 * has assembled model, auth and request headers -- so this cannot shadow a
 * credential the way a plain `streamOptions.headers` merge could. Wrapping the
 * runtime rather than the one `AgentHarness.create` call also covers the
 * requests that do not come from a turn, compaction summaries above all.
 */
export function withProviderAttribution(runtime: ModelRuntime): ModelRuntime {
  // Completion methods call their own streams on `this`. Bind them explicitly
  // here so the proxy's stream decoration also covers one-shot SDK calls.
  const stream: ModelRuntime["stream"] = (model, context, options) =>
    runtime.stream(model, context, {
      ...options,
      transformHeaders: attributionTransform(model, options),
    } as ModelsApiStreamOptions<typeof model.api>);
  const streamSimple: ModelRuntime["streamSimple"] = (model, context, options) =>
    runtime.streamSimple(model, context, { ...options, transformHeaders: attributionTransform(model, options) });

  return new Proxy(runtime, {
    get(target, property) {
      switch (property) {
        case "stream": return stream;
        case "streamSimple": return streamSimple;
        case "complete": {
          const complete: ModelRuntime["complete"] = (model, context, options) =>
            stream(model, context, options).result();
          return complete;
        }
        case "completeSimple": {
          const completeSimple: ModelRuntime["completeSimple"] = (model, context, options) =>
            streamSimple(model, context, options).result();
          return completeSimple;
        }
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function attributionTransform(
  model: Model<Api>,
  options: Pick<ModelsSimpleStreamOptions, "sessionId" | "transformHeaders"> | undefined,
) {
  return async (headers: ProviderHeaders) =>
    mergeProviderAttributionHeaders(
      model,
      options?.sessionId,
      await options?.transformHeaders?.(headers) ?? headers,
    ) ?? {};
}
