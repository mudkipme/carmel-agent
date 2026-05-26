import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent } from "@earendil-works/pi-ai";

export const OLLAMA_PROVIDER = "ollama";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

export type User = {
  id: string;
  username?: string;
  name: string;
  email: string;
  fastTaskModelRefId?: string;
};

export type AuthUser = User & {
  username: string;
};

export type AgentPermissions = {
  read: boolean;
  write: boolean;
  edit: boolean;
  bash: boolean;
  network: boolean;
  javascript: boolean;
  artifacts: boolean;
  documentExtract: boolean;
};

export type PromptTemplate = {
  id: string;
  name: string;
  body: string;
};

export type AgentWorkingDirMode = "default" | "manual";
export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AgentSkillCommand = {
  name: string;
  description: string;
  filePath: string;
};

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

export type ClientToolName = "javascript_repl" | "extract_document" | "artifacts";

export type ClientToolCallEvent = {
  type: "client_tool_call";
  runId: string;
  toolCallId: string;
  toolName: ClientToolName;
  args: Record<string, unknown>;
  nonce: string;
};

export type ClientToolResultPayload = {
  runId: string;
  toolCallId: string;
  nonce: string;
  result?: AgentToolResult<unknown>;
  error?: string;
};

export type ActiveAgentRunSummary = {
  runId: string;
  sessionId: string;
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
  customHeaders?: string;
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
  customHeaders?: string;
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
  skills: string[];
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
  messages: AgentMessage[];
  forkedFrom?: {
    sessionId: string;
    messageIndex: number;
  };
  createdAt: number;
  updatedAt: number;
};

export type SessionMetadata = Omit<Session, "messages"> & {
  messageCount: number;
};

export type SessionDraft = Pick<Session, "agentId" | "modelRefId"> & Partial<Pick<Session, "thinkingLevel">>;

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
