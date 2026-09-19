import type {
  AgentCommandPayload,
  GitChangeArea,
  GitFileDiff,
  GitStatus,
  AgentConfig,
  AgentConfigCommand,
  AgentFileBatchCommand,
  AgentFileBatchResult,
  AgentFileContent,
  AgentFileEntry,
  AgentFileList,
  AgentSecret,
  AgentTask,
  AgentTaskCreateCommand,
  AgentTaskPatchCommand,
  AgentTaskRun,
  ApiKey,
  ApiKeyCreated,
  CreateUserRequest,
  Issue,
  IssueCreateCommand,
  IssuePatchCommand,
  ModelCatalog,
  ModelRefCommand,
  OAuthLoginFlowState,
  OAuthProviderSummary,
  ModelRef,
  ProviderConfig,
  ProviderConfigCommand,
  ProviderModelSummary,
  Session,
  SessionConnection,
  SessionDraft,
  SessionPatch,
  SessionImportResult,
  SessionMetadata,
  SetupStatus,
  User,
  UserUpdateRequest,
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
  modelCatalog: ModelCatalog;
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

/**
 * The one place credentials are attached. Returns the raw `Response` without
 * throwing, for callers (streaming runs) that must inspect status codes
 * themselves; everything else should go through `request`.
 */
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

/** Build the `ApiError` for a failed response, unwrapping the server's `{error}` body. */
export async function apiError(response: Response, fallback = `Request failed: ${response.status}`) {
  const body = await response.text().catch(() => "");
  return new ApiError(readErrorMessage(body) || fallback, response.status);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) throw await apiError(response);
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

export type UploadOptions = {
  overwrite?: boolean;
  signal?: AbortSignal;
  /** Fraction of the file sent so far, 0 to 1. */
  onProgress?: (fraction: number) => void;
};

/**
 * XHR rather than fetch: it is still the only way to observe upload progress,
 * and a file manager without a progress bar feels broken on anything large.
 */
function uploadAgentFile(agentId: string, path: string, file: Blob, options: UploadOptions) {
  const query = new URLSearchParams({ path });
  if (options.overwrite) query.set("overwrite", "true");

  return new Promise<AgentFileEntry>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/agents/${agentId}/files/upload?${query}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(1);
        resolve(JSON.parse(xhr.responseText) as AgentFileEntry);
        return;
      }
      reject(new ApiError(readErrorMessage(xhr.responseText) || `Upload failed: ${xhr.status}`, xhr.status));
    });
    xhr.addEventListener("error", () => reject(new ApiError(`Unable to upload ${path}`, 0)));
    xhr.addEventListener("abort", () => reject(new ApiError("Upload cancelled", 0)));
    options.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
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
  listApiKeys: () => request<ApiKey[]>("/api/api-keys"),
  createApiKey: (name: string) =>
    request<ApiKeyCreated>("/api/api-keys", { method: "POST", body: JSON.stringify({ name }) }),
  deleteApiKey: (apiKeyId: string) => request<{ ok: true }>(`/api/api-keys/${apiKeyId}`, { method: "DELETE" }),
  upsertUser: (userId: string, input: UserUpdateRequest) =>
    request<User>(`/api/users/${userId}`, { method: "PUT", body: JSON.stringify(input) }),
  upsertModelRef: (modelId: string, input: ModelRefCommand) =>
    request<ModelRef>(`/api/models/${modelId}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteModelRef: (modelRefId: string) =>
    request<BootstrapPayload>(`/api/models/${modelRefId}`, { method: "DELETE" }),
  upsertProviderConfig: (providerConfigId: string, input: ProviderConfigCommand) =>
    request<ProviderConfig>(`/api/provider-configs/${providerConfigId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteProviderConfig: (providerConfigId: string) =>
    request<BootstrapPayload>(`/api/provider-configs/${providerConfigId}`, { method: "DELETE" }),
  listProviderModels: (providerConfigId: string, options: { refresh?: boolean } = {}) =>
    request<ProviderModelSummary[]>(
      `/api/provider-configs/${providerConfigId}/models${options.refresh ? "?refresh=true" : ""}`,
    ),
  upsertAgent: (agentId: string, input: AgentConfigCommand) =>
    request<AgentConfig>(`/api/agents/${agentId}`, { method: "PUT", body: JSON.stringify(input) }),
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
  getAgentGitStatus: (agentId: string) => request<GitStatus>(`/api/agents/${agentId}/git/status`),
  getAgentGitDiff: (agentId: string, change: { path: string; area: GitChangeArea; originalPath?: string }) =>
    request<GitFileDiff>(
      `/api/agents/${agentId}/git/diff?${new URLSearchParams({
        path: change.path,
        area: change.area,
        ...(change.originalPath ? { originalPath: change.originalPath } : {}),
      })}`,
    ),
  readAgentFile: (agentId: string, path: string) =>
    request<AgentFileContent>(`/api/agents/${agentId}/files/content?${new URLSearchParams({ path })}`),
  getAgentFileRawUrl: (agentId: string, path: string) =>
    `/api/agents/${agentId}/files/raw?${new URLSearchParams({ path })}`,
  /** One path downloads that file; a directory or several paths download a zip. */
  getAgentFileDownloadUrl: (agentId: string, paths: string[]) =>
    `/api/agents/${agentId}/files/download?${new URLSearchParams(paths.map((path) => ["path", path]))}`,
  uploadAgentFile: (agentId: string, path: string, file: Blob, options: UploadOptions = {}) =>
    uploadAgentFile(agentId, path, file, options),
  batchAgentFiles: (agentId: string, input: AgentFileBatchCommand) =>
    request<AgentFileBatchResult>(`/api/agents/${agentId}/files/batch`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
  listAgentSecrets: (agentId: string) => request<AgentSecret[]>(`/api/agents/${agentId}/secrets`),
  writeAgentSecret: (agentId: string, name: string, value: string) =>
    request<AgentSecret>(`/api/agents/${agentId}/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
  deleteAgentSecret: (agentId: string, name: string) =>
    request<{ ok: true }>(`/api/agents/${agentId}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  listAgentTasks: (agentId: string) => request<AgentTask[]>(`/api/agents/${agentId}/tasks`),
  createAgentTask: (agentId: string, input: AgentTaskCreateCommand) =>
    request<AgentTask>(`/api/agents/${agentId}/tasks`, { method: "POST", body: JSON.stringify(input) }),
  updateAgentTask: (agentId: string, taskId: string, patch: AgentTaskPatchCommand) =>
    request<AgentTask>(`/api/agents/${agentId}/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteAgentTask: (agentId: string, taskId: string) =>
    request<{ ok: true }>(`/api/agents/${agentId}/tasks/${taskId}`, { method: "DELETE" }),
  runAgentTaskNow: (agentId: string, taskId: string) =>
    request<{ outcome: string; detail?: string; sessionId?: string }>(`/api/agents/${agentId}/tasks/${taskId}/run`, {
      method: "POST",
    }),
  listAgentTaskRuns: (agentId: string, taskId: string) =>
    request<AgentTaskRun[]>(`/api/agents/${agentId}/tasks/${taskId}/runs`),
  listIssues: (agentId: string) => request<Issue[]>(`/api/agents/${agentId}/issues`),
  getIssue: (agentId: string, issueId: string) => request<Issue>(`/api/agents/${agentId}/issues/${issueId}`),
  createIssue: (agentId: string, input: IssueCreateCommand) =>
    request<Issue>(`/api/agents/${agentId}/issues`, { method: "POST", body: JSON.stringify(input) }),
  updateIssue: (agentId: string, issueId: string, patch: IssuePatchCommand) =>
    request<Issue>(`/api/agents/${agentId}/issues/${issueId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  interruptIssue: (agentId: string, issueId: string) =>
    request<Issue>(`/api/agents/${agentId}/issues/${issueId}/interrupt`, { method: "POST" }),
  cancelIssue: (agentId: string, issueId: string) =>
    request<Issue>(`/api/agents/${agentId}/issues/${issueId}/cancel`, { method: "POST" }),
  deleteIssue: (agentId: string, issueId: string) =>
    request<{ ok: true }>(`/api/agents/${agentId}/issues/${issueId}`, { method: "DELETE" }),
  deleteAgent: (agentId: string) =>
    request<{ ok: true }>(`/api/agents/${agentId}`, { method: "DELETE" }),
  createSession: (draft: SessionDraft & { title?: string }) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(draft) }),
  importOpenWebuiSessions: (draft: SessionDraft & { source: unknown }) =>
    request<SessionImportResult>("/api/sessions/import/open-webui", {
      method: "POST",
      body: JSON.stringify(draft),
    }),
  getSessionConnection: (sessionId: string, signal?: AbortSignal) =>
    request<SessionConnection>(`/api/sessions/${encodeURIComponent(sessionId)}/connection`, { signal }),
  abortAgentRun: (runId: string) =>
    request<unknown>(`/api/agent-runs/${encodeURIComponent(runId)}/abort`, { method: "POST" }),
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
  listArchivedSessions: (agentId: string) =>
    request<SessionMetadata[]>(`/api/agents/${agentId}/archived-sessions`),
  deleteSession: (sessionId: string) =>
    request<{ ok: true }>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
};
