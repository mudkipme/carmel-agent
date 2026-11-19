import type {
  HelpersState,
  HelperSummary,
  HomeMemory,
  HomeMemoryDreamReport,
  HomeMemoryInput,
  HomeMemoryMode,
  HomeMemoryOverview,
  HomeMemoryPatch,
  HomeMemoryRevision,
  HomeMemorySearchInput,
  HomeMemorySearchResult,
  HomeMemoryTidyReport,
  Issue,
  IssueCreateCommand,
  IssueDetail,
  IssuePatchCommand,
  IssueRunCommand,
  KnowledgeSettings,
  QuestionAnswer,
  Session,
  SessionConnection,
  SessionDraft,
  SessionImportResult,
  SessionMetadata,
  SessionPatch,
  SessionSearchResult,
  SessionSecret,
  UserRequest,
} from "@carmel-agent/shared";
import { call, type EditSessionMessageOptions } from "./core.ts";

export const sessionsApi = {
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
  searchSessions: (query: string, signal?: AbortSignal): Promise<SessionSearchResult[]> =>
    call("searchSessions", { query: { q: query }, signal, cache: "no-store" }),
  listSessions: (signal?: AbortSignal): Promise<SessionMetadata[]> =>
    call("listSessions", { signal }),
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
  sessionSubtasks: (sessionId: string, signal?: AbortSignal): Promise<HelpersState> =>
    call("getSessionHelpers", { path: { id: sessionId }, signal }),
  getSubtask: (
    sessionId: string,
    helperId: number,
    before?: string,
    signal?: AbortSignal,
  ): Promise<{ helper: HelperSummary; session: Session }> =>
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
