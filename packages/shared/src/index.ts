import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentMcpServer, AgentMount, AgentPermissions, AgentThinkingLevel, CodemodeCallInfo, PromptTemplate } from "./schemas.ts";
import type { Session } from "./sessions.ts";
export type { BrowserControlState, BrowserTab, BrowserFrame, BrowserClientMessage, BrowserServerMessage } from "./browser.ts";

export type ChatAttachment = {
  id: string;
  type: "image" | "document";
  fileName: string;
  mimeType: string;
  size: number;
  content?: string;
  extractedText?: string;
  preview?: string;
  url?: string;
};

export type UserMessageWithAttachments = {
  role: "user-with-attachments";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
  attachments?: ChatAttachment[];
};

export type ArtifactMessage = {
  role: "artifact";
  action: "create" | "update" | "delete";
  filename: string;
  content?: string;
  title?: string;
  timestamp: string;
};

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    "user-with-attachments": UserMessageWithAttachments;
    artifact: ArtifactMessage;
  }
}

export {
  isEditableAssistantMessage,
  isUserMessage,
  updateAssistantMessageContent,
  updateUserMessageContent,
} from "./messages.ts";
export type { UserMessageEditOptions } from "./messages.ts";
export * from "./commands.ts";
export * from "./run-events.ts";
export * from "./models.ts";
export * from "./records.ts";
export * from "./schemas.ts";
export * from "./sessions.ts";

export type UserRole = "admin" | "user";

export type User = {
  id: string;
  username?: string;
  name: string;
  email: string;
  role: UserRole;
  fastTaskModelRefId?: string;
  /** False for accounts that only sign in through OIDC. */
  hasPassword?: boolean;
};

export type AuthUser = User & {
  username: string;
};

export type SetupStatus = {
  needsSetup: boolean;
  /** Whether username/password sign-in (and the setup form) is available. */
  passwordLogin: boolean;
  /** Present when OpenID Connect sign-in is configured. */
  oidc?: { providerName: string };
};

/**
 * Why an OIDC sign-in was refused. Sent back to the login page as
 * `?auth_error=<code>`; the page owns the wording.
 */
export type OidcLoginErrorCode =
  | "not_allowed"
  | "not_linked"
  | "ambiguous_account"
  | "already_linked"
  | "expired"
  | "denied"
  | "failed";

export type AgentWorkingDirMode = "default" | "manual";

/**
 * How a run ended.
 *
 * - `succeeded`: the last turn ended without an error and its result was saved.
 * - `failed`: the provider rejected the turn, the run threw, the run guard
 *   stopped it, or its result could not be saved.
 * - `cancelled`: a person stopped it.
 * - `interrupted`: the server shut down before it finished.
 */
export type AgentRunOutcome = "succeeded" | "failed" | "cancelled" | "interrupted";

export type AgentRunResult = {
  outcome: AgentRunOutcome;
  /** Why it did not succeed, in words a person can act on. */
  detail?: string;
};

/** Emitted after server-side run finalization, including persistence and title work, has completed. */
export type AgentRunFinishedEvent = {
  type: "run_finished";
  result: AgentRunResult;
};

/**
 * Wire protocol for the run event stream, deliberately narrower than Pi's
 * `AgentEvent`.
 *
 * Pi emits the whole message-so-far on every token -- twice over, as
 * `message_update.message` and again as `assistantMessageEvent.partial` -- which
 * makes a streamed reply cost O(n^2) bytes. Streamed text and thinking travel
 * here as deltas instead, so a reply costs O(n), and every field the client does
 * not render is dropped rather than forwarded. The server projects Pi's events
 * into this shape; see `runtime/run-events.ts`.
 */
export type AgentRunEvent =
  | { type: "message_start"; message: AgentMessage }
  /** Append `delta` to the `text`/`thinking` of the content part at `contentIndex`. */
  | { type: "message_delta"; contentIndex: number; field: "text" | "thinking"; delta: string }
  /** Replace the whole content part at `contentIndex`. Tool calls arrive this way, not as deltas. */
  | { type: "message_part"; contentIndex: number; part: ToolCall }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "tool_execution_update"; toolCallId: string; codemodeCalls: CodemodeCallInfo[] }
  | { type: "turn_end"; errorMessage?: string }
  /**
   * Automatic compaction could not keep the session inside its context budget.
   *
   * Carried on the run stream rather than persisted as a message: it describes
   * the session's configuration, not anything the agent said, and it stops being
   * true the moment the session moves onto a model with a bigger window. The
   * client shows it until the next run starts.
   */
  | { type: "context_pressure"; level: "warning" | "critical"; message: string }
  /**
   * A turn failed and the server fixed it without the user doing anything.
   *
   * Distinct from `context_pressure` because it must also *clear* the error the
   * client already showed: the failing `turn_end` reached it before the server
   * knew the failure was recoverable.
   */
  | { type: "run_recovered"; message: string }
  | { type: "agent_end" }
  | AgentRunFinishedEvent;

export type AgentRunEventEnvelope = {
  sequence: number;
  event: AgentRunEvent;
};

export type ActiveAgentRunSummary = {
  runId: string;
  sessionId: string;
  eventCursor: number;
};
export type SessionConnection = {
  session: Session;
  activeRun: ActiveAgentRunSummary | null;
};


export type ProviderConfig = {
  id: string;
  userId: string;
  label: string;
  provider: string;
  authType?: "api_key" | "oauth";
  apiKey?: string;
  hasApiKey?: boolean;
  hasOAuth?: boolean;
  baseUrl?: string;
  createdAt: number;
  updatedAt: number;
};

export type OAuthProviderSummary = {
  id: string;
  name: string;
  usesCallbackServer?: boolean;
};

export type OAuthLoginFlowState = {
  id: string;
  providerConfigId: string;
  provider: string;
  providerName: string;
  status: "pending" | "auth" | "input" | "success" | "error";
  auth?: {
    url: string;
    instructions?: string;
  };
  prompt?: {
    kind: "prompt" | "manual_code" | "select";
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
    options?: Array<{ id: string; label: string }>;
  };
  progress?: string;
  error?: string;
};

export type AgentConfig = {
  id: string;
  ownerUserId: string;
  shared: boolean;
  name: string;
  description: string;
  workingDirMode: AgentWorkingDirMode;
  workingDir: string;
  defaultWorkingDir?: string;
  mounts: AgentMount[];
  systemPrompt: string;
  promptTemplates: PromptTemplate[];
  permissions: AgentPermissions;
  codemodeEnabled?: boolean;
  mcpServers?: AgentMcpServer[];
  defaultModelRefId: string;
  defaultThinkingLevel: AgentThinkingLevel;
  createdAt: number;
  updatedAt: number;
};

export type AgentMcpTestResult = { tools: Array<{ name: string; label: string }> };

/**
 * A secret as the browser is allowed to see it: the name and when it changed,
 * never the value. Values are supplied only to the agent's sandbox or its
 * configured MCP connections.
 */
export type AgentSecret = {
  agentId: string;
  name: string;
  updatedAt: number;
};

/**
 * A key for the OpenAI-compatible `/v1` API as a list shows it. The key itself
 * is returned exactly once, on creation, as `ApiKeyCreated.key`.
 */
export type ApiKey = {
  id: string;
  name: string;
  /** The first characters of the key, enough to tell keys apart. */
  prefix: string;
  lastUsedAt?: number;
  createdAt: number;
};

export type ApiKeyCreated = ApiKey & { key: string };

export type TaskScheduleKind = "cron" | "interval" | "once";
export type AgentTaskStatus = "active" | "paused" | "completed" | "disabled";
/** `missed` and `skipped` are recorded like any other firing: not running is a result. */
/** A firing either ran, ending the way any run ends, or never ran at all. */
export type AgentTaskOutcome = AgentRunOutcome | "missed" | "skipped";
/** A run is logged when it starts, so the log can link its session while it is still going. */
export type AgentTaskRunOutcome = AgentTaskOutcome | "running";

export type AgentTask = {
  id: string;
  agentId: string;
  userId: string;
  name: string;
  prompt: string;
  modelRefId?: string;
  thinkingLevel?: AgentThinkingLevel;
  scheduleKind: TaskScheduleKind;
  scheduleValue: string;
  timezone?: string;
  status: AgentTaskStatus;
  nextRunAt?: number;
  lastRunAt?: number;
  lastOutcome?: AgentTaskOutcome;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentTaskRun = {
  id: string;
  taskId: string;
  scheduledFor: number;
  startedAt: number;
  finishedAt?: number;
  outcome: AgentTaskRunOutcome;
  detail?: string;
  /** The run's own session. Absent for firings that never ran. */
  sessionId?: string;
};

/** Durable work owned by one agent; runs share a conversation unless explicitly started fresh. */
export type IssueStatus = "backlog" | "todo" | "queued" | "in_progress" | "needs_input" | "blocked" | "in_review" | "done" | "cancelled";
export type IssueVerdict = "done" | "needs_input" | "blocked";
export type IssuePriority = "low" | "normal" | "high" | "urgent";
export type Issue = {
  id: string;
  agentId: string;
  userId: string;
  sessionId?: string;
  title: string;
  description: string;
  criteria: string[];
  priority: IssuePriority;
  status: IssueStatus;
  running: boolean;
  queuePosition?: number;
  queuedInstructions?: string;
  lastRunOutcome?: AgentRunOutcome;
  lastRunDetail?: string;
  verdict?: IssueVerdict;
  verdictSummary?: string;
  closedAt?: number;
  createdAt: number;
  updatedAt: number;
};
export type IssueAttempt = {
  id: string;
  issueId: string;
  sessionId: string | null;
  instructions: string;
  brief: string;
  outcome: AgentRunOutcome | "running";
  summary: string | null;
  evidence: string | null;
  snapshot?: IssueResultSnapshot | null;
  createdAt: number;
  finishedAt: number | null;
};
export type IssueNote = {
  id: string;
  issueId: string;
  kind: "note" | "action" | "result";
  body: string;
  delivery?: "queued" | "delivered" | "not_delivered" | null;
  entryId?: string | null;
  createdAt: number;
};
export type IssueDetail = Issue & { attempts: IssueAttempt[]; notes: IssueNote[] };
export type IssueResultSnapshot = {
  files: { path: string; change: "added" | "modified" | "deleted"; before: string | null; after: string | null; omitted?: boolean }[];
  warning?: string;
  capturedAt: number;
};

export type AgentFileEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  updatedAt: number;
  hidden: boolean;
};

export type AgentFileList = {
  path: string;
  entries: AgentFileEntry[];
};

export type AgentFileContent = {
  path: string;
  content: string;
  updatedAt: number;
};

/** Where a change sits: in the index, only in the working tree, new, or mid-merge. */
export type GitChangeArea = "staged" | "unstaged" | "untracked" | "conflicted";

export type GitChangeKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "untracked" | "conflicted";

export type GitChange = {
  /** Relative to the repository root. */
  path: string;
  /** The path before a rename or copy. */
  originalPath?: string;
  /** Workspace-relative, for opening the file; absent when the repository root is outside the workspace. */
  workspacePath?: string;
  area: GitChangeArea;
  kind: GitChangeKind;
};

export type GitStatus =
  | { repository: false }
  | {
      repository: true;
      /** The branch, or undefined on a detached HEAD. */
      branch?: string;
      /** The commit HEAD points at; absent before the first commit. */
      head?: string;
      ahead?: number;
      behind?: number;
      changes: GitChange[];
      /** The change list was cut off at the server's limit. */
      truncated: boolean;
    };

/** One side of a file diff. The client computes the diff itself from the two texts. */
export type GitDiffSide =
  | { kind: "text"; text: string }
  /** The file does not exist on this side: added, deleted, or untracked. */
  | { kind: "absent" }
  | { kind: "binary" }
  | { kind: "too_large"; bytes: number };

export type GitFileDiff = {
  path: string;
  originalPath?: string;
  area: GitChangeArea;
  original: GitDiffSide;
  modified: GitDiffSide;
};

/**
 * Batch operations are best-effort per path: one unreadable entry must not
 * cancel the rest of the selection, so both halves are reported.
 */
export type AgentFileBatchResult = {
  completed: string[];
  failed: { path: string; error: string }[];
};
