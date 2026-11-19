import { i18n } from "@lingui/core";
import { apiRoutes } from "@carmel-agent/shared/api";
import type {
  AgentCommandPayload,
  AgentConfig,
  AgentConfigCommand,
  AgentFileBatchCommand,
  AgentFileBatchResult,
  AgentFileContent,
  AgentFileEntry,
  AgentFileList,
  AgentMcpServer,
  AgentMcpTestResult,
  AgentTask,
  AgentTaskCreateCommand,
  AgentTaskPatchCommand,
  AgentTaskRun,
  BrowserControlState,
  CollaborationConnection,
  CollaborationSummary,
  Collaborator,
  GitChangeArea,
  GitFileDiff,
  GitStatus,
  ImDelivery,
  ImIntegration,
  ImPlatform,
  ImSetup,
  KnowledgeDocument,
  KnowledgeOverview,
  KnowledgeReadInput,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSettings,
  KnowledgeSource,
  KnowledgeSourceInput,
} from "@carmel-agent/shared";
import { ApiError, apiUrl, call, readErrorMessage, type UploadOptions } from "./core.ts";

/**
 * XHR rather than fetch: it is still the only way to observe upload progress,
 * and a file manager without a progress bar feels broken on anything large.
 */
function uploadAgentFile(agentId: string, path: string, file: Blob, options: UploadOptions) {
  return new Promise<AgentFileEntry>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ApiError(i18n._("Upload cancelled"), 0));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(
      apiRoutes.uploadAgentFile.method,
      apiUrl(
        apiRoutes.uploadAgentFile.path,
        { id: agentId },
        { path, overwrite: options.overwrite || undefined },
      ),
    );
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const entry = JSON.parse(xhr.responseText) as AgentFileEntry;
          options.onProgress?.(1);
          resolve(entry);
        } catch (error) {
          reject(error);
        }
        return;
      }
      reject(
        new ApiError(
          readErrorMessage(xhr.responseText) ||
            i18n._("Upload failed: {status}", { status: xhr.status }),
          xhr.status,
        ),
      );
    });
    xhr.addEventListener("error", () =>
      reject(new ApiError(i18n._("Unable to upload {path}", { path }), 0)),
    );
    xhr.addEventListener("abort", () => reject(new ApiError(i18n._("Upload cancelled"), 0)));
    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.addEventListener("loadend", () => options.signal?.removeEventListener("abort", abort), {
      once: true,
    });
    xhr.send(file);
  });
}

export const agentsApi = {
  getCollaborators: (agentId: string, signal?: AbortSignal): Promise<Collaborator[]> =>
    call("getCollaborators", { path: { agentId }, signal }),
  getCollaborations: (agentId: string, signal?: AbortSignal): Promise<CollaborationSummary[]> =>
    call("getCollaborations", { path: { agentId }, signal }),
  cancelCollaboration: (agentId: string, id: string) =>
    call("cancelCollaboration", { path: { agentId, id } }),
  getCollaborationConnections: (agentId: string): Promise<CollaborationConnection[]> =>
    call("getCollaborationConnections", { path: { agentId } }),
  saveCollaborationConnection: (
    agentId: string,
    input: CollaborationConnection,
  ): Promise<CollaborationConnection[]> =>
    call("saveCollaborationConnection", { path: { agentId }, body: input }),
  listImIntegrations: (agentId: string, signal?: AbortSignal): Promise<ImIntegration[]> =>
    call("listImIntegrations", { path: { agentId }, signal }),
  listImSetups: (agentId: string, signal?: AbortSignal): Promise<ImSetup[]> =>
    call("listImSetups", { path: { agentId }, signal }),
  listImDeliveries: (agentId: string, signal?: AbortSignal): Promise<ImDelivery[]> =>
    call("listImDeliveries", { path: { agentId }, signal }),
  connectIm: (
    agentId: string,
    input: { platform: ImPlatform; token?: string; appId?: string; appSecret?: string },
  ): Promise<ImSetup> => call("connectIm", { path: { agentId }, body: input }),
  beginImQr: (agentId: string, platform: "feishu" | "lark"): Promise<ImSetup> =>
    call("beginImQr", { path: { agentId }, body: { platform } }),
  cancelImSetup: (agentId: string, setupId: string): Promise<{ ok: boolean }> =>
    call("cancelImSetup", { path: { agentId, setupId } }),
  updateIm: (
    agentId: string,
    integrationId: string,
    patch: { enabled?: boolean; proactive?: boolean; notificationDefault?: boolean },
  ): Promise<{ ok: boolean }> =>
    call("updateIm", { path: { agentId, integrationId }, body: patch }),
  disconnectIm: (agentId: string, integrationId: string): Promise<{ ok: boolean }> =>
    call("disconnectIm", { path: { agentId, integrationId } }),
  browserStatus: (
    agentId: string,
    signal?: AbortSignal,
  ): Promise<{ control: BrowserControlState; available: boolean }> =>
    call("getAgentBrowserStatus", { path: { id: agentId }, signal }),
  upsertAgent: (agentId: string, input: AgentConfigCommand): Promise<AgentConfig> =>
    call("upsertAgent", { path: { id: agentId }, body: input }),
  getAgentSettings: (agentId: string): Promise<AgentConfig> =>
    call("getAgentSettings", { path: { id: agentId } }),
  deleteAgent: (agentId: string): Promise<{ ok: boolean }> =>
    call("deleteAgent", { path: { id: agentId } }),
  testAgentMcpServer: (agentId: string, server: AgentMcpServer): Promise<AgentMcpTestResult> =>
    call("testAgentMcpServer", { path: { id: agentId }, body: server }),
  getAgentCommands: (agentId: string): Promise<AgentCommandPayload> =>
    call("getAgentCommands", { path: { id: agentId } }),
  listAgentFiles: (agentId: string, path = "", showHidden = false): Promise<AgentFileList> =>
    call("listAgentFiles", {
      path: { id: agentId },
      query: { path, showHidden },
    }),
  getAgentGitStatus: (agentId: string): Promise<GitStatus> =>
    call("getAgentGitStatus", { path: { id: agentId } }),
  getAgentGitDiff: (
    agentId: string,
    change: { path: string; area: GitChangeArea; originalPath?: string },
  ): Promise<GitFileDiff> =>
    call("getAgentGitDiff", {
      path: { id: agentId },
      query: {
        path: change.path,
        area: change.area,
        ...(change.originalPath ? { originalPath: change.originalPath } : {}),
      },
    }),
  readAgentFile: (agentId: string, path: string): Promise<AgentFileContent> =>
    call("getAgentFileContent", { path: { id: agentId }, query: { path } }),
  getAgentFileRawUrl: (agentId: string, path: string) =>
    apiUrl(apiRoutes.getAgentFileImage.path, { id: agentId }, { path }),
  /** One path downloads that file; a directory or several paths download a zip. */
  getAgentFileDownloadUrl: (agentId: string, paths: string[]) =>
    apiUrl(apiRoutes.downloadAgentFiles.path, { id: agentId }, { path: paths }),
  uploadAgentFile: (agentId: string, path: string, file: Blob, options: UploadOptions = {}) =>
    uploadAgentFile(agentId, path, file, options),
  batchAgentFiles: (agentId: string, input: AgentFileBatchCommand): Promise<AgentFileBatchResult> =>
    call("batchAgentFileOperation", { path: { id: agentId }, body: input }),
  saveAgentFile: (agentId: string, path: string, content: string): Promise<AgentFileContent> =>
    call("putAgentFileContent", { path: { id: agentId }, body: { path, content } }),
  createAgentFileEntry: (
    agentId: string,
    path: string,
    type: AgentFileEntry["type"],
  ): Promise<AgentFileEntry> =>
    call("createAgentFile", { path: { id: agentId }, body: { path, type } }),
  renameAgentFileEntry: (agentId: string, path: string, newPath: string): Promise<AgentFileEntry> =>
    call("renameAgentFile", { path: { id: agentId }, body: { path, newPath } }),
  listAgentTasks: (agentId: string, signal?: AbortSignal): Promise<AgentTask[]> =>
    call("listAgentTasks", { path: { agentId }, signal }),
  createAgentTask: (agentId: string, input: AgentTaskCreateCommand): Promise<AgentTask> =>
    call("createAgentTask", { path: { agentId }, body: input }),
  updateAgentTask: (
    agentId: string,
    taskId: string,
    patch: AgentTaskPatchCommand,
  ): Promise<AgentTask> => call("updateAgentTask", { path: { agentId, taskId }, body: patch }),
  deleteAgentTask: (agentId: string, taskId: string): Promise<{ ok: boolean }> =>
    call("deleteAgentTask", { path: { agentId, taskId } }),
  runAgentTaskNow: (
    agentId: string,
    taskId: string,
  ): Promise<{ outcome: string; detail?: string; sessionId?: string }> =>
    call("runAgentTask", { path: { agentId, taskId } }),
  listAgentTaskRuns: (
    agentId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<AgentTaskRun[]> => call("listAgentTaskRuns", { path: { agentId, taskId }, signal }),
  knowledge: (agentId: string, signal?: AbortSignal): Promise<KnowledgeOverview> =>
    call("getKnowledge", { path: { agentId }, signal }),
  knowledgeSettings: (agentId: string, signal?: AbortSignal): Promise<KnowledgeSettings> =>
    call("getKnowledgeSettings", { path: { agentId }, signal }),
  saveKnowledgeSettings: (
    agentId: string,
    settings: KnowledgeSettings,
  ): Promise<KnowledgeSettings> =>
    call("saveKnowledgeSettings", { path: { agentId }, body: settings }),
  addKnowledgeSource: (agentId: string, input: KnowledgeSourceInput): Promise<KnowledgeSource> =>
    call("addKnowledgeSource", { path: { agentId }, body: input }),
  deleteKnowledgeSource: (agentId: string, sourceId: string) =>
    call("disconnectKnowledgeSource", { path: { agentId, sourceId } }),
  searchKnowledge: (
    agentId: string,
    input: KnowledgeSearchInput,
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResult> =>
    call("searchKnowledge", { path: { agentId }, body: input, signal }),
  readKnowledge: (
    agentId: string,
    input: KnowledgeReadInput,
    signal?: AbortSignal,
  ): Promise<KnowledgeDocument> =>
    call("readKnowledge", { path: { agentId }, body: input, signal }),
  refreshKnowledge: (agentId: string, embed = false, allowDownloads = false, deep = false) =>
    call("refreshKnowledge", { path: { agentId }, body: { embed, allowDownloads, deep } }),
};
