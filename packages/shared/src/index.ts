import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent } from "@earendil-works/pi-ai";

export type User = {
  id: string;
  username?: string;
  name: string;
  email: string;
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

export type AgentSkillCommand = {
  name: string;
  description: string;
  filePath: string;
};

export type AgentCommandPayload = {
  promptTemplates: PromptTemplate[];
  skills: AgentSkillCommand[];
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
  createdAt: number;
  updatedAt: number;
};

export type Session = {
  id: string;
  title: string;
  userId: string;
  agentId: string;
  modelRefId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  messages: AgentMessage[];
  forkedFrom?: {
    sessionId: string;
    messageIndex: number;
  };
  createdAt: number;
  updatedAt: number;
};

export type SessionDraft = Pick<Session, "agentId" | "modelRefId" | "thinkingLevel">;
