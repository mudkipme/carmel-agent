import type {
  AgentCommandPayload,
  AgentConfig,
  AgentFileContent,
  AgentFileEntry,
  AgentFileList,
  AgentSkillCommand,
  OAuthLoginFlowState,
  OAuthProviderSummary,
  ModelRef,
  ProviderConfig,
  ProviderModelSummary,
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
  listProviderModels: (providerConfigId: string) =>
    request<ProviderModelSummary[]>(`/api/provider-configs/${providerConfigId}/models`),
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
  listAgentFiles: (agentId: string, path = "", showHidden = false) =>
    request<AgentFileList>(
      `/api/agents/${agentId}/files?${new URLSearchParams({ path, showHidden: String(showHidden) })}`,
    ),
  readAgentFile: (agentId: string, path: string) =>
    request<AgentFileContent>(`/api/agents/${agentId}/files/content?${new URLSearchParams({ path })}`),
  getAgentFileRawUrl: (agentId: string, path: string) =>
    `/api/agents/${agentId}/files/raw?${new URLSearchParams({ path })}`,
  saveAgentFile: (agentId: string, path: string, content: string) =>
    request<AgentFileContent>(`/api/agents/${agentId}/files/content`, {
      method: "PUT",
      body: JSON.stringify({ path, content }),
    }),
  createAgentFileEntry: (agentId: string, path: string, type: AgentFileEntry["type"]) =>
    request<AgentFileEntry>(`/api/agents/${agentId}/files`, {
      method: "POST",
      body: JSON.stringify({ path, type }),
    }),
  renameAgentFileEntry: (agentId: string, path: string, newPath: string) =>
    request<AgentFileEntry>(`/api/agents/${agentId}/files`, {
      method: "PATCH",
      body: JSON.stringify({ path, newPath }),
    }),
  deleteAgentFileEntry: (agentId: string, path: string) =>
    request<{ ok: true }>(`/api/agents/${agentId}/files?${new URLSearchParams({ path })}`, { method: "DELETE" }),
  deleteAgent: (agentId: string) =>
    request<{ ok: true }>(`/api/agents/${agentId}`, { method: "DELETE" }),
  createSession: (draft: SessionDraft & { title?: string }) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(draft) }),
  getSession: (sessionId: string) => request<Session>(`/api/sessions/${sessionId}`),
  updateSession: (sessionId: string, patch: Partial<Session>) =>
    request<Session>(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  truncateSessionMessages: (sessionId: string, messageIndex: number, thinkingLevel?: Session["thinkingLevel"]) =>
    request<Session>(`/api/sessions/${sessionId}/messages/truncate`, {
      method: "POST",
      body: JSON.stringify({ messageIndex, thinkingLevel }),
    }),
  editSessionMessage: (
    sessionId: string,
    messageIndex: number,
    content: string,
    options?: { truncate?: boolean; thinkingLevel?: Session["thinkingLevel"] },
  ) =>
    request<Session>(`/api/sessions/${sessionId}/messages/${messageIndex}`, {
      method: "PATCH",
      body: JSON.stringify({ content, ...options }),
    }),
  forkSession: (sessionId: string, messageIndex: number) =>
    request<Session>(`/api/sessions/${sessionId}/fork`, {
      method: "POST",
      body: JSON.stringify({ messageIndex }),
    }),
  deleteSession: (sessionId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
};
