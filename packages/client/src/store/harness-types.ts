import type { EditSessionMessageOptions } from "@/lib/api";
import type {
  AgentConfig,
  Issue,
  IssueCreateCommand,
  IssuePatchCommand,
  ModelRef,
  ModelCatalog,
  PromptTemplate,
  ProviderConfig,
  Session,
  SessionConnection,
  SessionDraft,
  SessionMetadata,
  SessionPatch,
  SetupStatus,
  User,
} from "@carmel-agent/shared";

export type HarnessStatus = "idle" | "loading" | "ready" | "unauthenticated" | "setup" | "error";

export type HarnessState = {
  status: HarnessStatus;
  error?: string;
  /** How this server lets people sign in. Loaded whenever the app is signed out. */
  authOptions?: SetupStatus;
  users: User[];
  /** The signed-in user. */
  activeUserId: string;
  agents: AgentConfig[];
  /**
   * The agent opened most recently, remembered so `/` lands on it. Not a
   * selection: the open agent and session are whatever the URL names.
   */
  lastAgentId: string;
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  modelCatalog: ModelCatalog;
  sessions: SessionMetadata[];
  sessionDetails: Record<string, Session>;
  /** Issues of the agents whose issue lists have been loaded; not part of bootstrap. */
  issues: Issue[];
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (input: { username: string; password: string; email?: string; name?: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateAccount: (currentPassword: string, email: string, newPassword?: string) => Promise<void>;
  rememberAgent: (agentId: string) => void;
  upsertUser: (user: User) => Promise<void>;
  upsertAgent: (agent: AgentConfig) => Promise<void>;
  createAgent: (draft?: Partial<AgentConfig>) => Promise<AgentConfig>;
  deleteAgent: (agentId: string) => Promise<void>;
  upsertProviderConfig: (providerConfig: ProviderConfig) => Promise<void>;
  deleteProviderConfig: (providerConfigId: string) => Promise<void>;
  upsertModelRef: (model: ModelRef) => Promise<ModelRef>;
  deleteModelRef: (modelRefId: string) => Promise<void>;
  createSession: (draft: SessionDraft) => Promise<Session>;
  importOpenWebuiSessions: (draft: SessionDraft & { source: unknown }) => Promise<Session[]>;
  updateSession: (sessionId: string, patch: SessionPatch) => Promise<void>;
  truncateSessionMessages: (sessionId: string, entryId: string, thinkingLevel?: Session["thinkingLevel"]) => Promise<Session>;
  editSessionMessage: (
    sessionId: string,
    entryId: string,
    content: string,
    options?: EditSessionMessageOptions,
  ) => Promise<Session>;
  connectSession: (sessionId: string) => Promise<SessionConnection>;
  refreshSession: (sessionId: string) => Promise<Session>;
  forkSession: (sessionId: string, entryId: string) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  restoreSession: (sessionId: string) => Promise<void>;
  /** Bring a session that is not in the session list -- a task run's -- into the store so it can be opened. */
  loadUnlistedSession: (sessionId: string) => Promise<void>;
  moveSessionToList: (sessionId: string) => Promise<void>;
  loadIssues: (agentId: string, signal?: AbortSignal) => Promise<Issue[]>;
  loadIssue: (agentId: string, issueId: string) => Promise<Issue>;
  createIssue: (agentId: string, input: IssueCreateCommand) => Promise<Issue>;
  updateIssue: (issue: Issue, patch: IssuePatchCommand) => Promise<Issue>;
  interruptIssue: (issue: Issue) => Promise<Issue>;
  cancelIssue: (issue: Issue) => Promise<Issue>;
  deleteIssue: (issue: Issue) => Promise<void>;
  addPromptTemplate: (agentId: string, template: Omit<PromptTemplate, "id">) => Promise<void>;
  deletePromptTemplate: (agentId: string, templateId: string) => Promise<void>;
};

export type HarnessPersistedState = Pick<HarnessState, "lastAgentId">;
