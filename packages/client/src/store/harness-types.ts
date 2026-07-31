import type { EditSessionMessageOptions, SessionPatch } from "@/lib/api";
import type {
  AgentConfig,
  ModelRef,
  PromptTemplate,
  ProviderConfig,
  Session,
  SessionConnection,
  SessionDraft,
  SessionMetadata,
  User,
} from "@carmel-agent/shared";

export type HarnessStatus = "idle" | "loading" | "ready" | "unauthenticated" | "setup" | "error";

export type HarnessState = {
  status: HarnessStatus;
  error?: string;
  users: User[];
  activeUserId: string;
  agents: AgentConfig[];
  activeAgentId: string;
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  sessions: SessionMetadata[];
  sessionDetails: Record<string, Session>;
  activeSessionId: string;
  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (input: { username: string; password: string; email?: string; name?: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateAccount: (currentPassword: string, email: string, newPassword?: string) => Promise<void>;
  setActiveUser: (userId: string) => void;
  setActiveAgent: (agentId: string) => void;
  setActiveSession: (sessionId: string) => void;
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
  addPromptTemplate: (agentId: string, template: Omit<PromptTemplate, "id">) => Promise<void>;
  deletePromptTemplate: (agentId: string, templateId: string) => Promise<void>;
};

export type HarnessPersistedState = Pick<HarnessState, "activeUserId" | "activeAgentId" | "activeSessionId">;
