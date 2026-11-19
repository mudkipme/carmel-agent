import { i18n } from "@lingui/core";
import { apiRoutes, type ApiOperations } from "@carmel-agent/shared/api";
import { updateConnection } from "./update-connection.ts";
import type {
  HomeMemory,
  HomeMemoryInput,
  HomeMemoryPatch,
  HomeMemoryMode,
  HomeMemoryOverview,
  HomeMemoryRevision,
  HomeMemorySearchInput,
  HomeMemorySearchResult,
  HomeMemoryTidyReport,
  HomeMemoryDreamReport,
  KnowledgeOverview,
  KnowledgeSettings,
  KnowledgeSourceInput,
  KnowledgeSource,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeReadInput,
  KnowledgeDocument,
  BrowserControlState,
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
  Environment,
  EnvironmentCommand,
  EnvironmentSecret,
  UserRequest,
  QuestionAnswer,
  SessionSecret,
  ImIntegration,
  ImSetup,
  ImPlatform,
  ImDelivery,
  AgentTask,
  AgentTaskCreateCommand,
  AgentTaskPatchCommand,
  AgentTaskRun,
  ApiKey,
  ApiKeyCreated,
  CreateUserRequest,
  Issue,
  IssueDetail,
  IssueRunCommand,
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
  SessionSearchResult,
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
 * throwing, for run admission requests that must inspect status codes
 * themselves; everything else should go through `request`.
 */
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });
}

/** Build the `ApiError` for a failed response, unwrapping the server's `{error}` body. */
export async function apiError(
  response: Response,
  fallback = i18n._("Request failed: {status}", { status: response.status }),
) {
  const body = await response.text().catch(() => "");
  return new ApiError(readErrorMessage(body) || fallback, response.status);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) throw await apiError(response);
  const result = (await response.json()) as T;
  // A command response can arrive after a newer socket notification.
  if (init?.method && !["GET", "HEAD"].includes(init.method))
    queueMicrotask(() => updateConnection.refreshState(["sessions"]));
  return result;
}

type Operation = keyof ApiOperations;
type Query = Record<string, string | number | boolean | readonly string[] | undefined>;
type Fields<O extends Operation> = ([ApiOperations[O]["path"]] extends [never]
  ? unknown
  : { path: ApiOperations[O]["path"] }) &
  ([ApiOperations[O]["query"]] extends [never]
    ? unknown
    : object extends ApiOperations[O]["query"]
      ? { query?: ApiOperations[O]["query"] }
      : { query: ApiOperations[O]["query"] }) &
  ([ApiOperations[O]["body"]] extends [never] ? unknown : { body: ApiOperations[O]["body"] });
type CallOptions<O extends Operation> = Fields<O> & Omit<RequestInit, "body" | "method">;

/** The URL of an operation, with its path parameters encoded and its query appended. */
export function apiUrl(path: string, params: Record<string, string> = {}, query: Query = {}) {
  const url = path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name]!));
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) search.append(name, item);
    else search.append(name, String(value));
  }
  return search.size ? `${url}?${search}` : url;
}

/** Call an operation of the generated API contract; its path, query, body, and result are typed. */
export function call<O extends Operation>(
  operation: O,
  ...[options]: object extends Fields<O> ? [CallOptions<O>?] : [CallOptions<O>]
): Promise<ApiOperations[O]["response"]> {
  const { path, query, body, ...init } = (options ?? {}) as {
    path?: Record<string, string>;
    query?: Query;
    body?: unknown;
  } & RequestInit;
  const route = apiRoutes[operation];
  return request(apiUrl(route.path, path, query), {
    ...init,
    method: route.method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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
  return new Promise<AgentFileEntry>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ApiError(i18n._("Upload cancelled"), 0));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(
      apiRoutes.uploadAgentFile.method,
      apiUrl(
        apiRoutes.uploadAgentFile.path,
        { id: agentId },
        { path, overwrite: options.overwrite || undefined },
      ),
    );
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const entry = JSON.parse(xhr.responseText) as AgentFileEntry;
          options.onProgress?.(1);
          resolve(entry);
        } catch (error) {
          reject(error);
        }
        return;
      }
      reject(
        new ApiError(
          readErrorMessage(xhr.responseText) ||
            i18n._("Upload failed: {status}", { status: xhr.status }),
          xhr.status,
        ),
      );
    });
    xhr.addEventListener("error", () =>
      reject(new ApiError(i18n._("Unable to upload {path}", { path }), 0)),
    );
    xhr.addEventListener("abort", () => reject(new ApiError(i18n._("Upload cancelled"), 0)));
    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.addEventListener("loadend", () => options.signal?.removeEventListener("abort", abort), {
      once: true,
    });
    xhr.send(file);
  });
}

export const api = {
  getCollaborators: (
    agentId: string,
    signal?: AbortSignal,
  ): Promise<import("@carmel-agent/shared").Collaborator[]> =>
    call("getCollaborators", { path: { agentId }, signal }),
  getCollaborations: (
    agentId: string,
    signal?: AbortSignal,
  ): Promise<import("@carmel-agent/shared").CollaborationSummary[]> =>
    call("getCollaborations", { path: { agentId }, signal }),
  cancelCollaboration: (agentId: string, id: string) =>
    call("cancelCollaboration", { path: { agentId, id } }),
  getCollaborationConnections: (
    agentId: string,
  ): Promise<import("@carmel-agent/shared").CollaborationConnection[]> =>
    call("getCollaborationConnections", { path: { agentId } }),
  saveCollaborationConnection: (
    agentId: string,
    input: import("@carmel-agent/shared").CollaborationConnection,
  ): Promise<import("@carmel-agent/shared").CollaborationConnection[]> =>
    call("saveCollaborationConnection", { path: { agentId }, body: input }),
  answerQuestion: (
    sessionId: string,
    requestId: string,
    answer: QuestionAnswer,
  ): Promise<UserRequest> =>
    call("answerUserQuestion", { path: { id: sessionId, requestId }, body: answer }),
  provideRequestedSecret: (
    sessionId: string,
    requestId: string,
    value: string,
  ): Promise<UserRequest> =>
    call("provideRequestedSecret", {
      path: { id: sessionId, requestId },
      body: { value },
      cache: "no-store",
    }),
  useRequestedSecret: (sessionId: string, requestId: string): Promise<UserRequest> =>
    call("useRequestedSecret", { path: { id: sessionId, requestId } }),
  cancelUserRequest: (sessionId: string, requestId: string): Promise<UserRequest> =>
    call("cancelUserRequest", { path: { id: sessionId, requestId } }),
  listSessionSecrets: (sessionId: string): Promise<SessionSecret[]> =>
    call("listSessionSecrets", { path: { id: sessionId }, cache: "no-store" }),
  promoteSessionSecret: (sessionId: string, secretId: string): Promise<SessionSecret> =>
    call("promoteSessionSecret", { path: { id: sessionId, secretId } }),
  demoteEnvironmentSecret: (sessionId: string, secretId: string): Promise<SessionSecret> =>
    call("demoteEnvironmentSecret", { path: { id: sessionId, secretId } }),
  revokeSessionSecret: (sessionId: string, secretId: string): Promise<{ ok: boolean }> =>
    call("revokeSessionSecret", { path: { id: sessionId, secretId } }),
  listImIntegrations: (agentId: string, signal?: AbortSignal): Promise<ImIntegration[]> =>
    call("listImIntegrations", { path: { agentId }, signal }),
  listImSetups: (agentId: string, signal?: AbortSignal): Promise<ImSetup[]> =>
    call("listImSetups", { path: { agentId }, signal }),
  listImDeliveries: (agentId: string, signal?: AbortSignal): Promise<ImDelivery[]> =>
    call("listImDeliveries", { path: { agentId }, signal }),
  connectIm: (
    agentId: string,
    input: { platform: ImPlatform; token?: string; appId?: string; appSecret?: string },
  ): Promise<ImSetup> => call("connectIm", { path: { agentId }, body: input }),
  beginImQr: (agentId: string, platform: "feishu" | "lark"): Promise<ImSetup> =>
    call("beginImQr", { path: { agentId }, body: { platform } }),
  cancelImSetup: (agentId: string, setupId: string): Promise<{ ok: boolean }> =>
    call("cancelImSetup", { path: { agentId, setupId } }),
  updateIm: (
    agentId: string,
    integrationId: string,
    patch: { enabled?: boolean; proactive?: boolean; notificationDefault?: boolean },
  ): Promise<{ ok: boolean }> =>
    call("updateIm", { path: { agentId, integrationId }, body: patch }),
  disconnectIm: (agentId: string, integrationId: string): Promise<{ ok: boolean }> =>
    call("disconnectIm", { path: { agentId, integrationId } }),
  browserStatus: (
    agentId: string,
    signal?: AbortSignal,
  ): Promise<{ control: BrowserControlState; available: boolean }> =>
    call("getAgentBrowserStatus", { path: { id: agentId }, signal }),
  searchSessions: (query: string, signal?: AbortSignal): Promise<SessionSearchResult[]> =>
    call("searchSessions", { query: { q: query }, signal, cache: "no-store" }),
  bootstrap: (): Promise<BootstrapPayload> => call("getBootstrap"),
  listSessions: (signal?: AbortSignal): Promise<SessionMetadata[]> =>
    call("listSessions", { signal }),
  login: (username: string, password: string): Promise<BootstrapPayload> =>
    call("login", { body: { username, password } }),
  logout: (): Promise<{ ok: boolean }> => call("logout"),
  setupStatus: (): Promise<SetupStatus> => call("getAuthStatus"),
  setup: (input: {
    username: string;
    password: string;
    email?: string;
    name?: string;
  }): Promise<BootstrapPayload> => call("setup", { body: input }),
  listUsers: (): Promise<User[]> => call("listUsers"),
  createUser: (input: CreateUserRequest): Promise<User> => call("createUser", { body: input }),
  updateUserRole: (userId: string, role: UserRole): Promise<User> =>
    call("updateUserRole", { path: { id: userId }, body: { role } }),
  resetUserPassword: (userId: string, password: string): Promise<{ ok: boolean }> =>
    call("resetUserPassword", { path: { id: userId }, body: { password } }),
  deleteUser: (userId: string): Promise<{ ok: boolean }> =>
    call("deleteUser", { path: { id: userId } }),
  updateAccount: (currentPassword: string, email: string, newPassword?: string): Promise<User> =>
    call("updateAccount", { body: { currentPassword, email, newPassword } }),
  listApiKeys: (): Promise<ApiKey[]> => call("listApiKeys"),
  createApiKey: (name: string): Promise<ApiKeyCreated> => call("createApiKey", { body: { name } }),
  deleteApiKey: (apiKeyId: string): Promise<{ ok: boolean }> =>
    call("deleteApiKey", { path: { id: apiKeyId } }),
  upsertUser: (userId: string, input: UserUpdateRequest): Promise<User> =>
    call("updateUserProfile", { path: { id: userId }, body: input }),
  upsertModelRef: (modelId: string, input: ModelRefCommand): Promise<ModelRef> =>
    call("upsertModel", { path: { id: modelId }, body: input }),
  deleteModelRef: (modelRefId: string): Promise<BootstrapPayload> =>
    call("deleteModel", { path: { id: modelRefId } }),
  upsertProviderConfig: (
    providerConfigId: string,
    input: ProviderConfigCommand,
  ): Promise<ProviderConfig> =>
    call("upsertProviderConfig", { path: { id: providerConfigId }, body: input }),
  deleteProviderConfig: (providerConfigId: string): Promise<BootstrapPayload> =>
    call("deleteProviderConfig", { path: { id: providerConfigId } }),
  listProviderModels: (
    providerConfigId: string,
    options: { refresh?: boolean } = {},
  ): Promise<ProviderModelSummary[]> =>
    call("listProviderModels", {
      path: { id: providerConfigId },
      query: { refresh: options.refresh || undefined },
    }),
  upsertAgent: (agentId: string, input: AgentConfigCommand): Promise<AgentConfig> =>
    call("upsertAgent", { path: { id: agentId }, body: input }),
  getAgentSettings: (agentId: string): Promise<AgentConfig> =>
    call("getAgentSettings", { path: { id: agentId } }),
  testAgentMcpServer: (
    agentId: string,
    server: import("@carmel-agent/shared").AgentMcpServer,
  ): Promise<import("@carmel-agent/shared").AgentMcpTestResult> =>
    call("testAgentMcpServer", { path: { id: agentId }, body: server }),
  getOAuthProviders: (): Promise<OAuthProviderSummary[]> => call("listOAuthProviders"),
  startProviderOAuthLogin: (providerConfigId: string): Promise<OAuthLoginFlowState> =>
    call("startProviderOAuth", { path: { id: providerConfigId } }),
  getOAuthLoginFlow: (flowId: string): Promise<OAuthLoginFlowState> =>
    call("getOAuthFlow", { path: { id: flowId } }),
  submitOAuthLoginFlowInput: (flowId: string, value: string): Promise<OAuthLoginFlowState> =>
    call("submitOAuthInput", { path: { id: flowId }, body: { value } }),
  getAgentCommands: (agentId: string): Promise<AgentCommandPayload> =>
    call("getAgentCommands", { path: { id: agentId } }),
  listAgentFiles: (agentId: string, path = "", showHidden = false): Promise<AgentFileList> =>
    call("listAgentFiles", {
      path: { id: agentId },
      query: { path, showHidden },
    }),
  getAgentGitStatus: (agentId: string): Promise<GitStatus> =>
    call("getAgentGitStatus", { path: { id: agentId } }),
  getAgentGitDiff: (
    agentId: string,
    change: { path: string; area: GitChangeArea; originalPath?: string },
  ): Promise<GitFileDiff> =>
    call("getAgentGitDiff", {
      path: { id: agentId },
      query: {
        path: change.path,
        area: change.area,
        ...(change.originalPath ? { originalPath: change.originalPath } : {}),
      },
    }),
  readAgentFile: (agentId: string, path: string): Promise<AgentFileContent> =>
    call("getAgentFileContent", { path: { id: agentId }, query: { path } }),
  getAgentFileRawUrl: (agentId: string, path: string) =>
    apiUrl(apiRoutes.getAgentFileImage.path, { id: agentId }, { path }),
  /** One path downloads that file; a directory or several paths download a zip. */
  getAgentFileDownloadUrl: (agentId: string, paths: string[]) =>
    apiUrl(apiRoutes.downloadAgentFiles.path, { id: agentId }, { path: paths }),
  uploadAgentFile: (agentId: string, path: string, file: Blob, options: UploadOptions = {}) =>
    uploadAgentFile(agentId, path, file, options),
  batchAgentFiles: (agentId: string, input: AgentFileBatchCommand): Promise<AgentFileBatchResult> =>
    call("batchAgentFileOperation", { path: { id: agentId }, body: input }),
  saveAgentFile: (agentId: string, path: string, content: string): Promise<AgentFileContent> =>
    call("putAgentFileContent", { path: { id: agentId }, body: { path, content } }),
  createAgentFileEntry: (
    agentId: string,
    path: string,
    type: AgentFileEntry["type"],
  ): Promise<AgentFileEntry> =>
    call("createAgentFile", { path: { id: agentId }, body: { path, type } }),
  renameAgentFileEntry: (agentId: string, path: string, newPath: string): Promise<AgentFileEntry> =>
    call("renameAgentFile", { path: { id: agentId }, body: { path, newPath } }),
  listEnvironments: (signal?: AbortSignal): Promise<Environment[]> =>
    call("listEnvironments", { signal, cache: "no-store" }),
  createEnvironment: (input: EnvironmentCommand): Promise<Environment> =>
    call("createEnvironment", { body: input }),
  updateEnvironment: (environmentId: string, input: EnvironmentCommand): Promise<Environment> =>
    call("updateEnvironment", { path: { id: environmentId }, body: input }),
  deleteEnvironment: (environmentId: string): Promise<{ ok: boolean }> =>
    call("deleteEnvironment", { path: { id: environmentId } }),
  listEnvironmentSecrets: (environmentId: string): Promise<EnvironmentSecret[]> =>
    call("listEnvironmentSecrets", { path: { environmentId } }),
  environmentWorkspaceDotEnvStatus: (
    environmentId: string,
    agentId: string,
  ): Promise<{ available: boolean }> =>
    call("getEnvironmentWorkspaceDotEnvStatus", {
      path: { environmentId },
      query: { agent: agentId },
    }),
  importEnvironmentWorkspaceDotEnv: (
    environmentId: string,
    agentId: string,
  ): Promise<{ imported: number; skippedExisting: number; skippedInvalid: number }> =>
    call("importEnvironmentWorkspaceDotEnv", {
      path: { environmentId },
      query: { agent: agentId },
    }),
  writeEnvironmentSecret: (
    environmentId: string,
    name: string,
    value: string,
  ): Promise<EnvironmentSecret> =>
    call("writeEnvironmentSecret", { path: { environmentId, name }, body: { value } }),
  deleteEnvironmentSecret: (environmentId: string, name: string): Promise<{ ok: boolean }> =>
    call("deleteEnvironmentSecret", { path: { environmentId, name } }),
  listAgentTasks: (agentId: string, signal?: AbortSignal): Promise<AgentTask[]> =>
    call("listAgentTasks", { path: { agentId }, signal }),
  knowledge: (agentId: string, signal?: AbortSignal): Promise<KnowledgeOverview> =>
    call("getKnowledge", { path: { agentId }, signal }),
  knowledgeSettings: (agentId: string, signal?: AbortSignal): Promise<KnowledgeSettings> =>
    call("getKnowledgeSettings", { path: { agentId }, signal }),
  saveKnowledgeSettings: (
    agentId: string,
    settings: KnowledgeSettings,
  ): Promise<KnowledgeSettings> =>
    call("saveKnowledgeSettings", { path: { agentId }, body: settings }),
  addKnowledgeSource: (agentId: string, input: KnowledgeSourceInput): Promise<KnowledgeSource> =>
    call("addKnowledgeSource", { path: { agentId }, body: input }),
  deleteKnowledgeSource: (agentId: string, sourceId: string) =>
    call("disconnectKnowledgeSource", { path: { agentId, sourceId } }),
  searchKnowledge: (
    agentId: string,
    input: KnowledgeSearchInput,
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResult> =>
    call("searchKnowledge", { path: { agentId }, body: input, signal }),
  readKnowledge: (
    agentId: string,
    input: KnowledgeReadInput,
    signal?: AbortSignal,
  ): Promise<KnowledgeDocument> =>
    call("readKnowledge", { path: { agentId }, body: input, signal }),
  refreshKnowledge: (agentId: string, embed = false, allowDownloads = false, deep = false) =>
    call("refreshKnowledge", { path: { agentId }, body: { embed, allowDownloads, deep } }),
  createAgentTask: (agentId: string, input: AgentTaskCreateCommand): Promise<AgentTask> =>
    call("createAgentTask", { path: { agentId }, body: input }),
  updateAgentTask: (
    agentId: string,
    taskId: string,
    patch: AgentTaskPatchCommand,
  ): Promise<AgentTask> => call("updateAgentTask", { path: { agentId, taskId }, body: patch }),
  deleteAgentTask: (agentId: string, taskId: string): Promise<{ ok: boolean }> =>
    call("deleteAgentTask", { path: { agentId, taskId } }),
  runAgentTaskNow: (
    agentId: string,
    taskId: string,
  ): Promise<{ outcome: string; detail?: string; sessionId?: string }> =>
    call("runAgentTask", { path: { agentId, taskId } }),
  listAgentTaskRuns: (
    agentId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<AgentTaskRun[]> => call("listAgentTaskRuns", { path: { agentId, taskId }, signal }),
  runIssue: (agentId: string, issueId: string, input: IssueRunCommand): Promise<IssueDetail> =>
    call("runIssue", { path: { agentId, issueId }, body: input }),
  addIssueNote: (agentId: string, issueId: string, body: string): Promise<IssueDetail> =>
    call("addIssueNote", { path: { agentId, issueId }, body: { body } }),
  sendIssueUpdate: (agentId: string, issueId: string, body: string): Promise<IssueDetail> =>
    call("sendIssueUpdate", { path: { agentId, issueId }, body: { body } }),
  removeIssueFromQueue: (agentId: string, issueId: string): Promise<IssueDetail> =>
    call("removeIssueFromQueue", { path: { agentId, issueId } }),
  moveQueuedIssue: (
    agentId: string,
    issueId: string,
    direction: "up" | "down",
  ): Promise<IssueDetail> =>
    call("moveQueuedIssue", { path: { agentId, issueId }, body: { direction } }),
  acceptIssue: (agentId: string, issueId: string): Promise<IssueDetail> =>
    call("acceptIssue", { path: { agentId, issueId } }),
  reopenIssue: (agentId: string, issueId: string): Promise<IssueDetail> =>
    call("reopenIssue", { path: { agentId, issueId } }),
  listIssues: (agentId: string, signal?: AbortSignal): Promise<Issue[]> =>
    call("listIssues", { path: { agentId }, signal }),
  getIssue: (agentId: string, issueId: string, signal?: AbortSignal): Promise<IssueDetail> =>
    call("getIssue", { path: { agentId, issueId }, signal }),
  createIssue: (agentId: string, input: IssueCreateCommand): Promise<Issue> =>
    call("createIssue", { path: { agentId }, body: input }),
  updateIssue: (agentId: string, issueId: string, patch: IssuePatchCommand): Promise<Issue> =>
    call("updateIssue", { path: { agentId, issueId }, body: patch }),
  interruptIssue: (agentId: string, issueId: string): Promise<Issue> =>
    call("interruptIssue", { path: { agentId, issueId } }),
  cancelIssue: (agentId: string, issueId: string): Promise<Issue> =>
    call("cancelIssue", { path: { agentId, issueId } }),
  deleteIssue: (agentId: string, issueId: string): Promise<{ ok: boolean }> =>
    call("deleteIssue", { path: { agentId, issueId } }),
  deleteAgent: (agentId: string): Promise<{ ok: boolean }> =>
    call("deleteAgent", { path: { id: agentId } }),
  sessionSubtasks: (
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<import("@carmel-agent/shared").HelpersState> =>
    call("getSessionHelpers", { path: { id: sessionId }, signal }),
  getSubtask: (
    sessionId: string,
    helperId: number,
    before?: string,
    signal?: AbortSignal,
  ): Promise<{ helper: import("@carmel-agent/shared").HelperSummary; session: Session }> =>
    call("getSessionHelper", {
      path: { id: sessionId, helperId: String(helperId) },
      query: { before },
      signal,
    }),
  stopSubtask: (sessionId: string, helperId: number): Promise<{ ok: boolean }> =>
    call("stopSessionHelper", { path: { id: sessionId, helperId: String(helperId) } }),
  resumeSubtasks: (sessionId: string): Promise<{ ok: boolean }> =>
    call("resumeSessionHelpers", { path: { id: sessionId } }),
  homeSummaries: (
    signal?: AbortSignal,
  ): Promise<
    Array<{
      agentId: string;
      sessionId: string;
      unread: boolean;
      working: boolean;
      needsAttention: boolean;
    }>
  > => call("listHomeSummaries", { signal }),
  readHome: (agentId: string, readAt: number): Promise<{ ok: boolean }> =>
    call("readAgentHome", { path: { agentId }, body: { readAt } }),
  resumeHome: (agentId: string): Promise<{ ok: boolean }> =>
    call("resumeAgentHome", { path: { agentId } }),
  homeStatus: (
    agentId: string,
    signal?: AbortSignal,
  ): Promise<{
    home: { sessionId: string; paused: boolean; activityAt: number; lastReadAt: number } | null;
    deliveries: Array<{
      id: string;
      status: string;
      error?: string | null;
      eventId?: string | null;
    }>;
    events: Array<{
      id: string;
      status: string;
      kind: string;
      error?: string | null;
      createdAt: number;
    }>;
  }> => call("getAgentHome", { path: { agentId }, signal }),
  dismissHomeError: (agentId: string, eventId: string): Promise<{ ok: boolean }> =>
    call("dismissAgentHomeError", { path: { agentId, eventId } }),
  stopHome: (agentId: string): Promise<{ ok: boolean }> =>
    call("stopAgentHome", { path: { agentId } }),
  ensureHome: (agentId: string): Promise<{ home: { sessionId: string }; session: Session }> =>
    call("ensureAgentHome", { path: { agentId } }),
  resetHome: (agentId: string): Promise<{ ok: boolean }> =>
    call("resetAgentHome", { path: { agentId } }),
  homeMemory: (
    agentId: string,
    query = "",
    offset = 0,
    signal?: AbortSignal,
  ): Promise<HomeMemoryOverview> =>
    call("getHomeMemory", { path: { agentId }, query: { q: query, offset }, signal }),
  setHomeMemoryMode: (agentId: string, mode: HomeMemoryMode): Promise<{ mode: HomeMemoryMode }> =>
    call("setHomeMemorySettings", { path: { agentId }, body: { mode } }),
  setHomeMemoryRetrieval: (agentId: string, retrieval: KnowledgeSettings) =>
    call("setHomeMemorySettings", { path: { agentId }, body: { retrieval } }),
  searchHomeMemory: (
    agentId: string,
    input: HomeMemorySearchInput,
    signal?: AbortSignal,
  ): Promise<HomeMemorySearchResult> =>
    call("searchHomeMemory", { path: { agentId }, body: input, signal }),
  refreshHomeMemory: (agentId: string, embed = false, allowDownloads = false, deep = false) =>
    call("refreshHomeMemoryIndex", { path: { agentId }, body: { embed, allowDownloads, deep } }),
  tidyHomeMemory: (
    agentId: string,
    dream = false,
  ): Promise<{ tidy: HomeMemoryTidyReport; dream: HomeMemoryDreamReport | null }> =>
    call("tidyHomeMemory", { path: { agentId }, body: { dream } }),
  saveHomeMemory: (agentId: string, input: HomeMemoryInput): Promise<HomeMemory> =>
    call("createHomeMemory", { path: { agentId }, body: input }),
  editHomeMemory: (agentId: string, id: string, input: HomeMemoryPatch): Promise<HomeMemory> =>
    call("editHomeMemory", { path: { agentId, id }, body: input }),
  forgetHomeMemory: (
    agentId: string,
    id: string,
    revision: number,
    preventLearning = true,
  ): Promise<{ ok: boolean }> =>
    call("forgetHomeMemory", { path: { agentId, id }, query: { revision, preventLearning } }),
  clearHomeMemory: (agentId: string): Promise<{ ok: boolean }> =>
    call("clearHomeMemory", { path: { agentId } }),
  homeMemoryHistory: (agentId: string, id: string): Promise<HomeMemoryRevision[]> =>
    call("getHomeMemoryHistory", { path: { agentId, id } }),
  restoreHomeMemory: (
    agentId: string,
    id: string,
    revision: number,
    expectedRevision: number,
  ): Promise<HomeMemory> =>
    call("restoreHomeMemory", { path: { agentId, id }, body: { revision, expectedRevision } }),
  getSessionHistory: (sessionId: string, before: string, around?: string): Promise<Session> =>
    call("readSessionHistory", { path: { id: sessionId }, query: { before, around } }),
  createSession: (draft: SessionDraft & { title?: string }): Promise<Session> =>
    call("createSession", { body: draft }),
  importOpenWebuiSessions: (
    draft: SessionDraft & { source: unknown },
  ): Promise<SessionImportResult> => call("importOpenWebUISessions", { body: draft }),
  getSessionConnection: (sessionId: string, signal?: AbortSignal): Promise<SessionConnection> =>
    call("getSessionConnection", { path: { id: sessionId }, signal }),
  listActiveSessions: (agentId: string, signal?: AbortSignal): Promise<{ sessionIds: string[] }> =>
    call("listActiveSessions", { path: { id: agentId }, signal }),
  abortAgentRun: (runId: string): Promise<unknown> => call("abortAgentRun", { path: { runId } }),
  updateSession: (sessionId: string, patch: SessionPatch): Promise<Session> =>
    call("patchSession", { path: { id: sessionId }, body: patch }),

  abortSession: (sessionId: string): Promise<{ ok: boolean }> =>
    call("abortSession", { path: { id: sessionId } }),
  truncateSessionMessages: (
    sessionId: string,
    entryId: string,
    thinkingLevel?: Session["thinkingLevel"],
  ): Promise<Session> =>
    call("truncateSession", { path: { id: sessionId }, body: { entryId, thinkingLevel } }),
  editSessionMessage: (
    sessionId: string,
    entryId: string,
    content: string,
    options?: EditSessionMessageOptions,
  ): Promise<Session> =>
    call("editSessionMessage", { path: { id: sessionId, entryId }, body: { content, ...options } }),
  forkSession: (sessionId: string, entryId: string): Promise<Session> =>
    call("forkSession", { path: { id: sessionId }, body: { entryId } }),
  listArchivedSessions: (agentId: string): Promise<SessionMetadata[]> =>
    call("listArchivedSessions", { path: { agentId } }),
  deleteSession: (sessionId: string): Promise<{ ok: boolean }> =>
    call("deleteSession", { path: { id: sessionId } }),
};
