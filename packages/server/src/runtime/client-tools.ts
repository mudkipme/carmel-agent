import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { agents } from "../db/schema.ts";
import type { ClientToolCallEvent, ClientToolName, ClientToolResultPayload } from "@carmel-agent/shared";

type AgentRecord = typeof agents.$inferSelect;
type JsonSchema = Record<string, unknown>;

type ClientToolContext = {
  runId: string;
  userId: string;
  sessionId: string;
  emit: (event: ClientToolCallEvent) => boolean;
};

type PendingClientToolCall = {
  userId: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolName: ClientToolName;
  nonce: string;
  resolve: (result: AgentToolResult<unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingClientTools = new Map<string, PendingClientToolCall>();
const CLIENT_TOOL_TIMEOUT_MS = 120_000;

export function createClientToolDefinitions(agent: AgentRecord, context: ClientToolContext): AgentTool[] {
  void agent;
  void context;
  return [];
}

export function createBrowserClientToolDefinitions(agent: AgentRecord, context: ClientToolContext) {
  const tools: AgentTool[] = [];
  if (agent.permissions.javascript) {
    tools.push(createProxyClientTool("javascript_repl", "JavaScript REPL", JAVASCRIPT_REPL_DESCRIPTION, javascriptReplSchema, context));
  }
  if (agent.permissions.documentExtract) {
    tools.push(createProxyClientTool("extract_document", "Extract Document", EXTRACT_DOCUMENT_DESCRIPTION, extractDocumentSchema, context));
  }
  if (agent.permissions.artifacts) {
    tools.push(createProxyClientTool("artifacts", "Artifacts", ARTIFACTS_DESCRIPTION, artifactsSchema, context));
  }
  return tools;
}

export function resolveClientToolResult(userId: string, payload: ClientToolResultPayload) {
  const pending = pendingClientTools.get(pendingKey(payload.runId, payload.toolCallId));
  if (!pending) throw new Error("Client tool call not found.");
  if (pending.userId !== userId) throw new Error("Client tool call not found.");
  if (pending.nonce !== payload.nonce) throw new Error("Invalid client tool result token.");

  pendingClientTools.delete(pendingKey(payload.runId, payload.toolCallId));
  clearTimeout(pending.timeout);

  if (payload.error) {
    pending.reject(new Error(payload.error));
    return;
  }

  pending.resolve(normalizeClientToolResult(payload.result));
}

export function cleanupRunClientTools(runId: string) {
  rejectRunClientTools(runId, "Agent run ended before the client tool returned.");
}

export function disconnectRunClientTools(runId: string) {
  rejectRunClientTools(runId, "Browser tool call was interrupted because the client disconnected.");
}

function rejectRunClientTools(runId: string, message: string) {
  for (const [key, pending] of pendingClientTools.entries()) {
    if (pending.runId !== runId) continue;
    pendingClientTools.delete(key);
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }
}

function createProxyClientTool(
  name: ClientToolName,
  label: string,
  description: string,
  parameters: JsonSchema,
  context: ClientToolContext,
): AgentTool {
  return {
    name,
    label,
    description,
    parameters: parameters as never,
    executionMode: "sequential",
    execute: (toolCallId, params, signal) =>
      requestClientTool(context, name, toolCallId, params as Record<string, unknown>, signal),
  };
}

function requestClientTool(
  context: ClientToolContext,
  toolName: ClientToolName,
  toolCallId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new Error("Client tool call aborted.");

  const key = pendingKey(context.runId, toolCallId);
  const nonce = randomId();
  return new Promise<AgentToolResult<unknown>>((resolve, reject) => {
    const cleanupAbort = () => {
      pendingClientTools.delete(key);
      clearTimeout(timeout);
      reject(new Error("Client tool call aborted."));
    };
    const timeout = setTimeout(() => {
      pendingClientTools.delete(key);
      signal?.removeEventListener("abort", cleanupAbort);
      reject(new Error(`Timed out waiting for browser tool "${toolName}".`));
    }, CLIENT_TOOL_TIMEOUT_MS);

    pendingClientTools.set(key, {
      userId: context.userId,
      sessionId: context.sessionId,
      runId: context.runId,
      toolCallId,
      toolName,
      nonce,
      resolve: (result) => {
        signal?.removeEventListener("abort", cleanupAbort);
        resolve(result);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", cleanupAbort);
        reject(error);
      },
      timeout,
    });

    signal?.addEventListener("abort", cleanupAbort, { once: true });
    const delivered = context.emit({
      type: "client_tool_call",
      runId: context.runId,
      toolCallId,
      toolName,
      args,
      nonce,
    });
    if (!delivered) {
      pendingClientTools.delete(key);
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cleanupAbort);
      reject(new Error(`Browser tool "${toolName}" is unavailable because the client disconnected.`));
    }
  });
}

function normalizeClientToolResult(result: AgentToolResult<unknown> | undefined): AgentToolResult<unknown> {
  if (!result || !Array.isArray(result.content)) throw new Error("Client tool result content is required.");
  const content = result.content.map((item) => {
    if (item?.type === "text" && typeof item.text === "string") {
      return { type: "text" as const, text: item.text };
    }
    if (item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      return { type: "image" as const, data: item.data, mimeType: item.mimeType };
    }
    throw new Error("Client tool returned unsupported content.");
  });
  return {
    content,
    details: result.details,
    terminate: result.terminate === true ? true : undefined,
  };
}

function pendingKey(runId: string, toolCallId: string) {
  return `${runId}:${toolCallId}`;
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

const javascriptReplSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Brief title describing what the code snippet tries to achieve in active form.",
    },
    code: { type: "string", description: "JavaScript code to execute in the browser sandbox." },
  },
  required: ["title", "code"],
  additionalProperties: false,
};

const extractDocumentSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL of the document to extract text from." },
  },
  required: ["url"],
  additionalProperties: false,
};

const artifactsSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["create", "update", "rewrite", "get", "delete", "logs"],
      description: "The operation to perform.",
    },
    filename: { type: "string", description: "Filename including extension." },
    content: { type: "string", description: "File content." },
    old_str: { type: "string", description: "String to replace for update." },
    new_str: { type: "string", description: "Replacement string for update." },
  },
  required: ["command", "filename"],
  additionalProperties: false,
};

const JAVASCRIPT_REPL_DESCRIPTION =
  "Execute JavaScript in the user's browser sandbox. Use this for browser-native JavaScript tasks and generated files.";
const EXTRACT_DOCUMENT_DESCRIPTION =
  "Extract text from a PDF, DOCX, XLSX, or PPTX document URL using the user's browser capabilities.";
const ARTIFACTS_DESCRIPTION =
  "Create, update, rewrite, read, delete, and inspect browser-rendered artifacts such as HTML, SVG, Markdown, and text files.";
