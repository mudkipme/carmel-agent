import { getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import type { OAuthLoginFlowState, OAuthProviderSummary } from "@carmel-agent/shared";
import { createProviderConfigAuthStorage } from "./auth-storage.ts";
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
  return getOAuthProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    usesCallbackServer: provider.usesCallbackServer,
  }));
}

export async function startOAuthLoginFlow(userId: string, providerConfig: ProviderConfigRecord) {
  const provider = getOAuthProvider(providerConfig.provider);
  if (!provider) throw new Error(`Provider ${providerConfig.provider} does not support OAuth login.`);

  const flow: OAuthFlow = {
    id: randomId("oauth_flow"),
    userId,
    providerConfigId: providerConfig.id,
    provider: provider.id,
    providerName: provider.name,
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
    const authStorage = createProviderConfigAuthStorage(providerConfig, providerConfig.provider);
    await authStorage.login(providerConfig.provider, {
      onAuth: (auth) => {
        flow.status = "auth";
        flow.auth = auth;
      },
      onDeviceCode: (info) => {
        flow.status = "auth";
        flow.auth = {
          url: info.verificationUri,
          instructions: [
            `Enter code: ${info.userCode}`,
            info.expiresInSeconds ? `This code expires in ${info.expiresInSeconds} seconds.` : undefined,
          ].filter(Boolean).join(" "),
        };
      },
      onProgress: (message) => {
        flow.progress = message;
      },
      onPrompt: (prompt) =>
        waitForInput(flow, {
          kind: "prompt",
          message: prompt.message,
          placeholder: prompt.placeholder,
          allowEmpty: prompt.allowEmpty,
        }),
      onManualCodeInput: () =>
        waitForInput(flow, {
          kind: "manual_code",
          message: "Paste the authorization code or full redirect URL.",
          allowEmpty: false,
        }),
      onSelect: (prompt) =>
        waitForInput(flow, {
          kind: "select",
          message: prompt.message,
          options: prompt.options,
        }).then((value) => value || undefined),
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

function waitForInput(
  flow: OAuthFlow,
  prompt: NonNullable<OAuthLoginFlowState["prompt"]>,
) {
  flow.status = "input";
  flow.prompt = prompt;
  return new Promise<string>((resolve, reject) => {
    flow.pendingInput = { resolve, reject };
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
