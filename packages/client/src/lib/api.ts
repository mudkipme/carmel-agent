import type {
  AgentCommandPayload,
  AgentConfig,
  AgentSkillCommand,
  OAuthLoginFlowState,
  OAuthProviderSummary,
  ModelRef,
  ProviderConfig,
  Session,
  SessionDraft,
  SessionMetadata,
  User,
} from "@carmel-agent/shared";

export type BootstrapPayload = {
  users: User[];
  agents: AgentConfig[];
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  sessions: SessionMetadata[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(readErrorMessage(body) || `Request failed: ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

function readErrorMessage(body: string) {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : body;
  } catch {
    return body;
  }
}

export const api = {
  bootstrap: () => request<BootstrapPayload>("/api/bootstrap"),
  login: (username: string, password: string) =>
    request<BootstrapPayload>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  upsertUser: (user: User) =>
    request<User>(`/api/users/${user.id}`, { method: "PUT", body: JSON.stringify(user) }),
  upsertModelRef: (model: ModelRef) =>
    request<ModelRef>(`/api/models/${model.id}`, { method: "PUT", body: JSON.stringify(model) }),
  deleteModelRef: (modelRefId: string) =>
    request<BootstrapPayload>(`/api/models/${modelRefId}`, { method: "DELETE" }),
  upsertProviderConfig: (providerConfig: ProviderConfig) =>
    request<ProviderConfig>(`/api/provider-configs/${providerConfig.id}`, {
      method: "PUT",
      body: JSON.stringify(providerConfig),
    }),
  deleteProviderConfig: (providerConfigId: string) =>
    request<BootstrapPayload>(`/api/provider-configs/${providerConfigId}`, { method: "DELETE" }),
  upsertAgent: (agent: AgentConfig) =>
    request<AgentConfig>(`/api/agents/${agent.id}`, { method: "PUT", body: JSON.stringify(agent) }),
  getAgentSettings: (agentId: string) => request<AgentConfig>(`/api/agents/${agentId}/settings`),
  getGlobalSkills: () => request<AgentSkillCommand[]>("/api/skills/global"),
  getOAuthProviders: () => request<OAuthProviderSummary[]>("/api/oauth/providers"),
  startProviderOAuthLogin: (providerConfigId: string) =>
    request<OAuthLoginFlowState>(`/api/provider-configs/${providerConfigId}/oauth/login`, { method: "POST" }),
  getOAuthLoginFlow: (flowId: string) => request<OAuthLoginFlowState>(`/api/oauth/flows/${flowId}`),
  submitOAuthLoginFlowInput: (flowId: string, value: string) =>
    request<OAuthLoginFlowState>(`/api/oauth/flows/${flowId}/input`, {
      method: "POST",
      body: JSON.stringify({ value }),
    }),
  getAgentCommands: (agentId: string) => request<AgentCommandPayload>(`/api/agents/${agentId}/commands`),
  deleteAgent: (agentId: string) =>
    request<{ ok: true }>(`/api/agents/${agentId}`, { method: "DELETE" }),
  createSession: (draft: SessionDraft & { title?: string }) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(draft) }),
  getSession: (sessionId: string) => request<Session>(`/api/sessions/${sessionId}`),
  updateSession: (sessionId: string, patch: Partial<Session>) =>
    request<Session>(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  forkSession: (sessionId: string, messageIndex: number) =>
    request<Session>(`/api/sessions/${sessionId}/fork`, {
      method: "POST",
      body: JSON.stringify({ messageIndex }),
    }),
  deleteSession: (sessionId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
};
