import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { AgentMount, AgentPermissions, AgentThinkingLevel, PromptTemplate } from "./schemas.ts";
import type { Session } from "./sessions.ts";

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
};

export type AuthUser = User & {
  username: string;
};

export type SetupStatus = {
  needsSetup: boolean;
};

export type AgentWorkingDirMode = "default" | "manual";

/** Emitted after server-side run finalization, including persistence and title work, has completed. */
export type AgentRunFinishedEvent = {
  type: "run_finished";
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
  defaultModelRefId: string;
  defaultThinkingLevel: AgentThinkingLevel;
  /**
   * Admin-installed extension providers this agent may use.
   *
   * Admin-only to change, even by the agent's owner: an extension runs
   * unsandboxed in the server process, so letting a regular user arm one on
   * their own agent would be a privilege escalation rather than a preference.
   */
  enabledExtensions: string[];
  createdAt: number;
  updatedAt: number;
};

/**
 * A secret as the browser is allowed to see it: the name and when it changed,
 * never the value. Values leave the database only on their way into a sandbox
 * container, the same rule provider credentials already follow.
 */
export type AgentSecret = {
  agentId: string;
  name: string;
  updatedAt: number;
};

export type TaskScheduleKind = "cron" | "interval" | "once";
export type AgentTaskStatus = "active" | "paused" | "completed" | "disabled";
/** `missed` and `skipped` are recorded like any other firing: not running is a result. */
export type AgentTaskOutcome = "succeeded" | "failed" | "missed" | "skipped";

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
  /** The task's own session. Absent until the first firing creates it. */
  sessionId?: string;
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
  outcome: AgentTaskOutcome;
  detail?: string;
};

export type InstalledExtension = {
  /** Provider id, as used in `AgentConfig.enabledExtensions`. */
  id: string;
  label: string;
  toolNames: string[];
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

/**
 * Batch operations are best-effort per path: one unreadable entry must not
 * cancel the rest of the selection, so both halves are reported.
 */
export type AgentFileBatchResult = {
  completed: string[];
  failed: { path: string; error: string }[];
};
