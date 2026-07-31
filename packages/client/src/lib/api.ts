import type {
  AgentCommandPayload,
  AgentConfig,
  AgentFileContent,
  AgentFileEntry,
  AgentFileList,
  CreateUserRequest,
  OAuthLoginFlowState,
  OAuthProviderSummary,
  ModelRef,
  ProviderConfig,
  ProviderModelSummary,
  Session,
  SessionConnection,
  SessionDraft,
  SessionImportResult,
  SessionMetadata,
  SetupStatus,
  User,
  UserRole,
  UserMessageEditOptions,
} from "@carmel-agent/shared";

export type EditSessionMessageOptions = UserMessageEditOptions & {
  truncate?: boolean;
  thinkingLevel?: Session["thinkingLevel"];
};

export type BootstrapPayload = {
  users: User[];
  agents: AgentConfig[];
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  sessions: SessionMetadata[];
};

export type SessionPatch = Omit<Partial<Session>, "pinnedAt"> & {
  pinnedAt?: number | null;
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
  setupStatus: () => request<SetupStatus>("/api/auth/status"),
  setup: (input: { username: string; password: string; email?: string; name?: string }) =>
    request<BootstrapPayload>("/api/auth/setup", { method: "POST", body: JSON.stringify(input) }),
  listUsers: () => request<User[]>("/api/users"),
  createUser: (input: CreateUserRequest) =>
    request<User>("/api/users", { method: "POST", body: JSON.stringify(input) }),
  updateUserRole: (userId: string, role: UserRole) =>
    request<User>(`/api/users/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  resetUserPassword: (userId: string, password: string) =>
    request<{ ok: true }>(`/api/users/${userId}/password`, { method: "POST", body: JSON.stringify({ password }) }),
  deleteUser: (userId: string) => request<{ ok: true }>(`/api/users/${userId}`, { method: "DELETE" }),
  updateAccount: (currentPassword: string, email: string, newPassword?: string) =>
    request<User>("/api/auth/account", {
      method: "POST",
      body: JSON.stringify({ currentPassword, email, newPassword }),
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
  importOpenWebuiSessions: (draft: SessionDraft & { source: unknown }) =>
    request<SessionImportResult>("/api/sessions/import/open-webui", {
      method: "POST",
      body: JSON.stringify(draft),
    }),
  getSessionConnection: (sessionId: string) =>
    request<SessionConnection>(`/api/sessions/${sessionId}/connection`),
  updateSession: (sessionId: string, patch: SessionPatch) =>
    request<Session>(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  truncateSessionMessages: (sessionId: string, entryId: string, thinkingLevel?: Session["thinkingLevel"]) =>
    request<Session>(`/api/sessions/${sessionId}/messages/truncate`, {
      method: "POST",
      body: JSON.stringify({ entryId, thinkingLevel }),
    }),
  editSessionMessage: (
    sessionId: string,
    entryId: string,
    content: string,
    options?: EditSessionMessageOptions,
  ) =>
    request<Session>(`/api/sessions/${sessionId}/messages/${encodeURIComponent(entryId)}`, {
      method: "PATCH",
      body: JSON.stringify({ content, ...options }),
    }),
  forkSession: (sessionId: string, entryId: string) =>
    request<Session>(`/api/sessions/${sessionId}/fork`, {
      method: "POST",
      body: JSON.stringify({ entryId }),
    }),
  deleteSession: (sessionId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
};
