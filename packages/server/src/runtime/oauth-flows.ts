import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { builtinModels, builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { OAuthLoginFlowState, OAuthProviderSummary } from "@carmel-agent/shared";
import { createProviderConfigCredentialStore } from "./auth-storage.ts";
import type { providerConfigs } from "../db/schema.ts";

type ProviderConfigRecord = typeof providerConfigs.$inferSelect;

type PendingInput = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type OAuthFlow = OAuthLoginFlowState & {
  userId: string;
  pendingInput?: PendingInput;
};

const flows = new Map<string, OAuthFlow>();
const flowTtlMs = 15 * 60 * 1000;

export function listOAuthProviders(): OAuthProviderSummary[] {
  return builtinProviders().flatMap((provider) =>
    provider.auth.oauth
      ? [{
          id: provider.id,
          name: provider.auth.oauth.name,
        }]
      : [],
  );
}

export async function startOAuthLoginFlow(userId: string, providerConfig: ProviderConfigRecord) {
  const provider = builtinProviders().find((candidate) => candidate.id === providerConfig.provider);
  if (!provider?.auth.oauth) throw new Error(`Provider ${providerConfig.provider} does not support OAuth login.`);

  const flow: OAuthFlow = {
    id: randomId("oauth_flow"),
    userId,
    providerConfigId: providerConfig.id,
    provider: provider.id,
    providerName: provider.auth.oauth.name,
    status: "pending",
  };
  flows.set(flow.id, flow);
  setTimeout(() => {
    const current = flows.get(flow.id);
    if (!current || current.status === "success" || current.status === "error") return;
    current.pendingInput?.reject(new Error("OAuth login expired."));
    current.status = "error";
    current.error = "OAuth login expired.";
  }, flowTtlMs).unref?.();

  void runOAuthLoginFlow(flow, providerConfig);
  await waitForFirstFlowEvent(flow);
  return serializeFlow(flow);
}

export function readOAuthLoginFlow(userId: string, flowId: string) {
  const flow = flows.get(flowId);
  if (!flow || flow.userId !== userId) return undefined;
  return serializeFlow(flow);
}

export function submitOAuthLoginFlowInput(userId: string, flowId: string, value: string) {
  const flow = flows.get(flowId);
  if (!flow || flow.userId !== userId) return undefined;
  if (!flow.pendingInput) throw new Error("OAuth login is not waiting for input.");
  const pending = flow.pendingInput;
  flow.pendingInput = undefined;
  flow.prompt = undefined;
  pending.resolve(value);
  return serializeFlow(flow);
}

async function runOAuthLoginFlow(flow: OAuthFlow, providerConfig: ProviderConfigRecord) {
  try {
    const credentials = createProviderConfigCredentialStore(providerConfig, providerConfig.provider);
    const models = builtinModels({ credentials });
    await models.login(providerConfig.provider, "oauth", {
      notify: (event) => notifyOAuthFlow(flow, event),
      prompt: (prompt) => promptOAuthFlow(flow, prompt),
    });
    flow.status = "success";
    flow.prompt = undefined;
    flow.progress = "OAuth login completed.";
  } catch (error) {
    flow.status = "error";
    flow.error = error instanceof Error ? error.message : String(error);
  } finally {
    flow.pendingInput = undefined;
  }
}

function notifyOAuthFlow(flow: OAuthFlow, event: AuthEvent) {
  switch (event.type) {
    case "auth_url":
      flow.status = "auth";
      flow.auth = { url: event.url, instructions: event.instructions };
      break;
    case "device_code":
      flow.status = "auth";
      flow.auth = {
        url: event.verificationUri,
        instructions: [
          `Enter code: ${event.userCode}`,
          event.expiresInSeconds ? `This code expires in ${event.expiresInSeconds} seconds.` : undefined,
        ].filter(Boolean).join(" "),
      };
      break;
    case "progress":
      flow.progress = event.message;
      break;
    case "info": {
      flow.progress = event.message;
      const link = event.links?.[0];
      if (link) {
        flow.status = "auth";
        flow.auth = { url: link.url, instructions: event.message };
      }
      break;
    }
  }
}

function promptOAuthFlow(flow: OAuthFlow, prompt: AuthPrompt) {
  if (prompt.type === "select") {
    return waitForInput(
      flow,
      {
        kind: "select",
        message: prompt.message,
        options: [...prompt.options],
      },
      prompt.signal,
    );
  }
  return waitForInput(
    flow,
    {
      kind: prompt.type === "manual_code" ? "manual_code" : "prompt",
      message: prompt.message,
      placeholder: prompt.placeholder,
      allowEmpty: false,
    },
    prompt.signal,
  );
}

function waitForInput(
  flow: OAuthFlow,
  prompt: NonNullable<OAuthLoginFlowState["prompt"]>,
  signal?: AbortSignal,
) {
  flow.status = "input";
  flow.prompt = prompt;
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      if (flow.pendingInput === pendingInput) {
        flow.pendingInput = undefined;
        flow.prompt = undefined;
      }
      reject(signal?.reason instanceof Error ? signal.reason : new Error("OAuth prompt cancelled."));
    };
    const pendingInput: PendingInput = {
      resolve: (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    };
    flow.pendingInput = pendingInput;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForFirstFlowEvent(flow: OAuthFlow) {
  return new Promise<void>((resolve) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (flow.status !== "pending" || Date.now() - startedAt > 30000) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

function serializeFlow(flow: OAuthFlow): OAuthLoginFlowState {
  return {
    id: flow.id,
    providerConfigId: flow.providerConfigId,
    provider: flow.provider,
    providerName: flow.providerName,
    status: flow.status,
    auth: flow.auth,
    prompt: flow.prompt,
    progress: flow.progress,
    error: flow.error,
  };
}

function randomId(prefix: string) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}
