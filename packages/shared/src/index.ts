import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent } from "@earendil-works/pi-ai";

export type User = {
  id: string;
  name: string;
  email: string;
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

export type AgentSkillCommand = {
  name: string;
  description: string;
  filePath: string;
};

export type AgentCommandPayload = {
  promptTemplates: PromptTemplate[];
  skills: AgentSkillCommand[];
};

export type PromptInput = {
  text: string;
  images?: ImageContent[];
};

export type ModelRef = {
  id: string;
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
  apiKey?: string;
  hasApiKey?: boolean;
  baseUrl?: string;
  customHeaders?: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentConfig = {
  id: string;
  ownerUserId: string;
  shared: boolean;
  name: string;
  description: string;
  workingDir: string;
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
