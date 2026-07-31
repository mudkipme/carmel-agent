import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, TextContent } from "@earendil-works/pi-ai";

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
export * from "./schemas.ts";
export { resolveModelRef } from "./model.ts";

export const OLLAMA_PROVIDER = "ollama";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

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

export type CreateUserRequest = {
  username: string;
  email: string;
  password: string;
  name?: string;
  role?: UserRole;
};

export type AgentPermissions = {
  read: boolean;
  write: boolean;
  edit: boolean;
  bash: boolean;
  network: boolean;
};

export type PromptTemplate = {
  id: string;
  name: string;
  body: string;
};

export type AgentMount = {
  source: string;
  target?: string;
  readOnly?: boolean;
};

export type AgentWorkingDirMode = "default" | "manual";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AgentSlashCommandSource = "prompt" | "skill";

export type AgentSlashCommand = {
  name: string;
  description?: string;
  source: AgentSlashCommandSource;
  commandText: string;
  sourcePath?: string;
  argumentHint?: string;
};

export type AgentCommandPayload = {
  commands: AgentSlashCommand[];
};

export type AgentRunEvent = AgentEvent | { type: string; [key: string]: unknown };

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


export type PromptInput = {
  text: string;
  images?: ImageContent[];
};

export type ModelRef = {
  id: string;
  ownerUserId: string;
  shared: boolean;
  label: string;
  provider: string;
  providerConfigId?: string;
  modelId: string;
  api?: Api;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
};

export type ProviderModelSummary = {
  id: string;
  name: string;
  api?: Api;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
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

export type Session = {
  id: string;
  title: string;
  userId: string;
  agentId: string;
  modelRefId: string;
  thinkingLevel: AgentThinkingLevel;
  revision: number;
  messages: AgentMessage[];
  messageEntryIds: string[];
  forkedFrom?: {
    sessionId: string;
    entryId: string;
  };
  pinnedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionMetadata = Omit<Session, "messages" | "messageEntryIds"> & {
  messageCount: number;
};

export type SessionDraft = Pick<Session, "agentId" | "modelRefId"> & Partial<Pick<Session, "thinkingLevel">>;

export type SessionImportResult = {
  sessions: Session[];
  skipped: number;
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
