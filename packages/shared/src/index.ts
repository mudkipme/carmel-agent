import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
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

export type AgentRunEvent = AgentEvent | AgentRunFinishedEvent;

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
  createdAt: number;
  updatedAt: number;
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
