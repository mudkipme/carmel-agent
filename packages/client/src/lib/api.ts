import type { AgentCommandPayload, AgentConfig, ModelRef, ProviderConfig, Session, SessionDraft, User } from "@carmel-agent/shared";

export type BootstrapPayload = {
  users: User[];
  agents: AgentConfig[];
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  sessions: Session[];
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(readErrorMessage(body) || `Request failed: ${response.status}`);
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
  getAgentSettings: (agentId: string, userId: string) =>
    request<AgentConfig>(`/api/agents/${agentId}/settings?userId=${encodeURIComponent(userId)}`),
  getAgentCommands: (agentId: string, userId: string) =>
    request<AgentCommandPayload>(`/api/agents/${agentId}/commands?userId=${encodeURIComponent(userId)}`),
  deleteAgent: (agentId: string) =>
    request<{ ok: true }>(`/api/agents/${agentId}`, { method: "DELETE" }),
  createSession: (draft: SessionDraft & { userId: string; title?: string }) =>
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
