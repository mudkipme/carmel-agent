import { z } from "zod";
import {
  accountUpdateRequestSchema,
  adminPasswordResetRequestSchema,
  agentConfigRequestSchema,
  agentRunRequestSchema,
  agentSecretWriteSchema,
  agentTaskCreateSchema,
  agentTaskPatchSchema,
  apiKeyCreateSchema,
  createFileEntryRequestSchema,
  createUserRequestSchema,
  environmentRequestSchema,
  fileBatchRequestSchema,
  fileContentRequestSchema,
  forkSessionRequestSchema,
  imConnectSchema,
  imQrBeginSchema,
  imSettingsSchema,
  issueCreateSchema,
  issueNoteSchema,
  issuePatchSchema,
  issueQueueMoveSchema,
  issueRunSchema,
  knowledgeReadSchema,
  knowledgeSearchSchema,
  knowledgeSettingsSchema,
  knowledgeSourceInputSchema,
  loginRequestSchema,
  modelRefRequestSchema,
  oauthInputRequestSchema,
  openWebuiImportRequestSchema,
  providerConfigRequestSchema,
  questionAnswerSchema,
  renameFileEntryRequestSchema,
  secretAnswerSchema,
  sessionDraftRequestSchema,
  sessionMessageEditRequestSchema,
  sessionPatchRequestSchema,
  sessionTruncateRequestSchema,
  setupRequestSchema,
  updateUserRoleRequestSchema,
  userRequestSchema,
  promptInputSchema,
  promptTemplateSchema,
  collaborationConnectionSchema,
  agentPermissionsSchema,
  collaborationGrantSchema,
  agentMcpServerSchema,
} from "@carmel-agent/shared";

export const AccountRequestSchema = accountUpdateRequestSchema.meta({ id: "AccountRequest" });

export const McpServerSchema = agentMcpServerSchema.meta({ id: "McpServer" });

export const ThinkingLevelSchema = z
  .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
  .meta({ id: "ThinkingLevel" });

export const AgentConfigSchema = z
  .strictObject({
    id: z.string(),
    ownerUserId: z.string(),
    shared: z.boolean(),
    name: z.string(),
    icon: z
      .enum([
        "bot",
        "sparkles",
        "orbit",
        "compass",
        "sprout",
        "sun",
        "moon",
        "rocket",
        "book",
        "code",
        "palette",
        "heart",
      ])
      .optional(),
    color: z.enum(["blue", "green", "orange", "purple", "cyan", "pink"]).optional(),
    description: z.string(),
    environmentId: z.string(),
    workingDir: z.string(),
    systemPrompt: z.string(),
    promptTemplates: z.array(promptTemplateSchema),
    permissions: agentPermissionsSchema,
    codemodeEnabled: z.boolean().meta({ default: false }).optional(),
    defaultModelRefId: z.string(),
    mcpServers: z.array(McpServerSchema).max(20).optional(),
    defaultThinkingLevel: ThinkingLevelSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: "AgentConfig" });

export const AgentMountSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().optional(),
    readOnly: z.boolean().optional(),
  })
  .meta({ id: "AgentMount" });

export const AgentRequestSchema = agentConfigRequestSchema.meta({ id: "AgentRequest" });

export const AgentRunRequestSchema = agentRunRequestSchema.meta({ id: "AgentRunRequest" });

export const AgentSecretRequestSchema = agentSecretWriteSchema.meta({ id: "AgentSecretRequest" });

export const AgentTaskSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    userId: z.string(),
    name: z.string(),
    prompt: z.string(),
    modelRefId: z.string().optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
    scheduleKind: z.enum(["cron", "interval", "once"]),
    scheduleValue: z.string(),
    timezone: z.string().optional(),
    notifyPlatform: z.enum(["telegram", "feishu", "lark"]).optional(),
    status: z.enum(["active", "paused", "completed", "disabled"]),
    nextRunAt: z.number().optional(),
    lastRunAt: z.number().optional(),
    lastOutcome: z
      .enum(["succeeded", "failed", "cancelled", "interrupted", "missed", "skipped"])
      .optional(),
    lastError: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: "AgentTask" });

export const AgentTaskCreateRequestSchema = agentTaskCreateSchema.meta({
  id: "AgentTaskCreateRequest",
});

export const AgentTaskPatchRequestSchema = agentTaskPatchSchema.meta({
  id: "AgentTaskPatchRequest",
});

export const ApiKeySchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    lastUsedAt: z.number().optional(),
    createdAt: z.number(),
  })
  .meta({ id: "ApiKey" });

export const ApiKeyCreateRequestSchema = apiKeyCreateSchema.meta({ id: "ApiKeyCreateRequest" });

export const ApiKeyCreatedSchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    lastUsedAt: z.number().optional(),
    createdAt: z.number(),
    key: z.string(),
  })
  .meta({ id: "ApiKeyCreated" });

export const UserSchema = z
  .object({
    id: z.string(),
    username: z.string().optional(),
    name: z.string(),
    email: z.string(),
    role: z.enum(["admin", "user"]),
    fastTaskModelRefId: z.string().optional(),
    hasPassword: z.boolean().optional(),
  })
  .meta({ id: "User" });

export const ProviderConfigSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    label: z.string(),
    provider: z.string(),
    authType: z.enum(["api_key", "oauth"]).optional(),
    hasApiKey: z.boolean().optional(),
    hasOAuth: z.boolean().optional(),
    baseUrl: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: "ProviderConfig" });

export const ModelRefSchema = z
  .strictObject({
    id: z.string(),
    ownerUserId: z.string(),
    shared: z.boolean(),
    label: z.string(),
    provider: z.string(),
    providerConfigId: z.string().optional(),
    modelId: z.string(),
    api: z.string().optional(),
    baseUrl: z.string().optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.enum(["text", "image"])).optional(),
    thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  })
  .meta({ id: "ModelRef" });

export const SessionMetadataSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    userId: z.string(),
    agentId: z.string(),
    modelRefId: z.string(),
    thinkingLevel: ThinkingLevelSchema,
    revision: z.number().int(),
    pinnedAt: z.number().optional(),
    archivedAt: z.number().optional(),
    taskId: z.string().optional(),
    issueId: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    home: z.boolean().optional(),
  })
  .meta({ id: "SessionMetadata" });

export const BootstrapPayloadSchema = z
  .object({
    users: z.array(UserSchema),
    agents: z.array(AgentConfigSchema),
    providerConfigs: z.array(ProviderConfigSchema),
    modelRefs: z.array(ModelRefSchema),
    modelCatalog: z.object({}).meta({ "x-typescript-type": "Shared.ModelCatalog" }),
    sessions: z.array(SessionMetadataSchema),
  })
  .meta({ id: "BootstrapPayload" });

export const CreateUserRequestSchema = createUserRequestSchema.meta({ id: "CreateUserRequest" });

export const EnvironmentSchema = z
  .strictObject({
    id: z.string(),
    ownerUserId: z.string(),
    name: z.string(),
    mounts: z.array(AgentMountSchema),
    network: z.boolean(),
    agents: z.array(z.strictObject({ id: z.string(), name: z.string() })),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: "Environment" });

export const EnvironmentRequestSchema = environmentRequestSchema.meta({ id: "EnvironmentRequest" });

export const EnvironmentSecretSchema = z
  .strictObject({ environmentId: z.string(), name: z.string(), updatedAt: z.number() })
  .meta({ id: "EnvironmentSecret" });

export const ErrorSchema = z.object({ error: z.string() }).meta({ id: "Error" });

export const FileBatchRequestSchema = fileBatchRequestSchema.meta({ id: "FileBatchRequest" });

export const FileBatchResultSchema = z
  .object({
    completed: z.array(z.string()),
    failed: z.array(z.object({ path: z.string(), error: z.string() })),
  })
  .meta({ id: "FileBatchResult" });

export const FileContentSchema = z
  .object({ path: z.string(), content: z.string(), updatedAt: z.number() })
  .meta({ id: "FileContent" });

export const FileContentRequestSchema = fileContentRequestSchema.meta({ id: "FileContentRequest" });

export const FileCreateRequestSchema = createFileEntryRequestSchema.meta({
  id: "FileCreateRequest",
});

export const FileEntrySchema = z
  .object({
    name: z.string(),
    path: z.string(),
    type: z.enum(["file", "directory"]),
    size: z.number().optional(),
    updatedAt: z.number(),
    hidden: z.boolean(),
  })
  .meta({ id: "FileEntry" });

export const FileListSchema = z
  .object({ path: z.string(), entries: z.array(FileEntrySchema) })
  .meta({ id: "FileList" });

export const FileRenameRequestSchema = renameFileEntryRequestSchema.meta({
  id: "FileRenameRequest",
});

export const ForkSessionRequestSchema = forkSessionRequestSchema.meta({ id: "ForkSessionRequest" });

export const GitChangeSchema = z
  .object({
    path: z.string(),
    originalPath: z.string().optional(),
    workspacePath: z.string().optional(),
    area: z.enum(["staged", "unstaged", "untracked", "conflicted"]),
    kind: z.enum([
      "added",
      "modified",
      "deleted",
      "renamed",
      "copied",
      "type_changed",
      "untracked",
      "conflicted",
    ]),
  })
  .meta({ id: "GitChange" });

export const GitDiffSideSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }),
    z.object({ kind: z.literal("absent") }),
    z.object({ kind: z.literal("binary") }),
    z.object({ kind: z.literal("too_large"), bytes: z.number().int() }),
  ])
  .meta({ id: "GitDiffSide" });

export const GitFileDiffSchema = z
  .object({
    path: z.string(),
    originalPath: z.string().optional(),
    area: z.enum(["staged", "unstaged", "untracked", "conflicted"]),
    original: GitDiffSideSchema,
    modified: GitDiffSideSchema,
  })
  .meta({ id: "GitFileDiff" });

export const GitStatusSchema = z
  .discriminatedUnion("repository", [
    z.object({ repository: z.literal(false) }),
    z.object({
      repository: z.literal(true),
      branch: z.string().optional(),
      head: z.string().optional(),
      ahead: z.number().int().optional(),
      behind: z.number().int().optional(),
      changes: z.array(GitChangeSchema),
      truncated: z.boolean(),
    }),
  ])
  .meta({ id: "GitStatus" });

export const HomeMemorySchema = z
  .strictObject({
    content: z.string().min(1).max(20000),
    title: z.string().max(200),
    scope: z.string().max(120),
    kind: z.enum(["preference", "fact", "decision"]),
    placement: z.enum(["core", "topic"]),
    aliases: z.array(z.string().min(1).max(40)).max(12),
    expiresAt: z.number().int().min(1).nullable(),
    aboutUser: z.boolean().optional(),
    id: z.string(),
    revision: z.number().int().min(1),
    pinned: z.boolean(),
    origin: z.enum(["manual", "explicit", "automatic"]),
    contributorId: z.string().nullable(),
    sourceEventId: z.string().nullable(),
    sourceEntryId: z.string().nullable(),
    sourceQuote: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .meta({ id: "HomeMemory" });

export const KnowledgeSettingsSchema = knowledgeSettingsSchema.meta({ id: "KnowledgeSettings" });

export const KnowledgeStatusSchema = z
  .object({
    state: z.enum(["disabled", "idle", "updating", "embedding", "ready", "error"]),
    lastUpdatedAt: z.number().int().nullable(),
    documents: z.number().int(),
    needsEmbedding: z.number().int(),
    error: z.string().nullable(),
    backend: z.string().nullable(),
    devices: z.array(z.string()),
  })
  .meta({ id: "KnowledgeStatus" });

export const HomeMemoryTidyReportSchema = z
  .object({
    at: z.number(),
    expired: z.number().int(),
    duplicates: z.number().int(),
    superseded: z.number().int(),
    organized: z.number().int(),
    coalesced: z.number().int(),
    contradictionsChecked: z.boolean(),
    note: z.string().nullable(),
  })
  .meta({ id: "HomeMemoryTidyReport" });

export const HomeMemoryDreamReportSchema = z
  .object({
    at: z.number(),
    conversations: z.number().int(),
    learned: z.array(z.object({ content: z.string(), scope: z.string() })),
    outdated: z.array(z.object({ was: z.string(), now: z.string() })),
    ideas: z.array(z.string()),
    aboutMe: z.number().int(),
    note: z.string().nullable(),
  })
  .meta({ id: "HomeMemoryDreamReport" });

export const HomeMemoryCaptureReportSchema = z
  .object({
    at: z.number(),
    model: z.string().nullable(),
    route: z.enum(["tool", "text", "none"]),
    stopReason: z.string(),
    candidates: z.number().int(),
    curated: z.number().int(),
    saved: z.number().int(),
    rejected: z.array(z.string()),
    usage: z
      .object({
        input: z.number(),
        output: z.number(),
        totalTokens: z.number(),
        cost: z.number(),
      })
      .nullable(),
    error: z.string().nullable(),
    lastTidy: HomeMemoryTidyReportSchema.nullable().optional(),
    lastDream: HomeMemoryDreamReportSchema.nullable().optional(),
    dreamedTo: z.number().nullable().optional(),
    judgedCore: z.array(z.string()).optional(),
  })
  .meta({ id: "HomeMemoryCaptureReport" });

export const HomeMemoryOverviewSchema = z
  .object({
    mode: z.enum(["off", "manual", "automatic"]),
    retrieval: KnowledgeSettingsSchema,
    indexStatus: KnowledgeStatusSchema,
    embeddingModel: z.string(),
    memories: z.array(HomeMemorySchema),
    sharedMemories: z.array(HomeMemorySchema).optional(),
    total: z.number().int().min(0),
    coreIds: z.array(z.string()),
    coreLines: z.number().int().min(0),
    coreBytes: z.number().int().min(0),
    coreMaxLines: z.number().int(),
    coreMaxBytes: z.number().int(),
    lastCaptureAt: z.number().int().nullable(),
    lastCapture: HomeMemoryCaptureReportSchema.nullable(),
    lastTidy: HomeMemoryTidyReportSchema.nullable().optional(),
    lastDream: HomeMemoryDreamReportSchema.nullable().optional(),
    error: z.string().nullable(),
  })
  .meta({ id: "HomeMemoryOverview" });

export const HomeMemoryRevisionSchema = z
  .object({
    content: z.string().min(1).max(20000),
    title: z.string().max(200).optional(),
    scope: z.string().max(120),
    kind: z.enum(["preference", "fact", "decision"]),
    placement: z.enum(["core", "topic"]).optional(),
    aliases: z.array(z.string().min(1).max(40)).max(12).optional(),
    expiresAt: z.number().int().min(1).nullable(),
    revision: z.number().int().min(1),
    createdAt: z.number().int(),
  })
  .meta({ id: "HomeMemoryRevision" });

export const HomeMemorySearchHitSchema = z
  .object({
    content: z.string().min(1).max(20000),
    title: z.string().max(200),
    scope: z.string().max(120),
    kind: z.enum(["preference", "fact", "decision"]),
    placement: z.enum(["core", "topic"]),
    aliases: z.array(z.string().min(1).max(40)).max(12),
    expiresAt: z.number().int().min(1).nullable(),
    aboutUser: z.boolean().optional(),
    id: z.string(),
    revision: z.number().int().min(1),
    pinned: z.boolean(),
    origin: z.enum(["manual", "explicit", "automatic"]),
    contributorId: z.string().nullable(),
    sourceEventId: z.string().nullable(),
    sourceEntryId: z.string().nullable(),
    sourceQuote: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .and(
    z.object({
      match: z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
    }),
  )
  .meta({ id: "HomeMemorySearchHit" });

export const ImConnectRequestSchema = imConnectSchema.meta({ id: "ImConnectRequest" });

export const ImDeliverySchema = z
  .strictObject({
    id: z.string(),
    platform: z.enum(["telegram", "feishu", "lark"]),
    status: z.enum(["pending", "sending", "sent", "failed", "cancelled", "uncertain"]),
    error: z.string().optional(),
    createdAt: z.number(),
  })
  .meta({ id: "ImDelivery" });

export const ImIntegrationSchema = z
  .strictObject({
    id: z.string(),
    agentId: z.string(),
    platform: z.enum(["telegram", "feishu", "lark"]),
    botId: z.string(),
    botName: z.string(),
    enabled: z.boolean(),
    proactive: z.boolean(),
    notificationDefault: z.boolean(),
    status: z.enum(["connecting", "connected", "disabled", "error"]),
    error: z.string().optional(),
    senderId: z.string(),
    sessionId: z.string().optional(),
    updatedAt: z.number(),
  })
  .meta({ id: "ImIntegration" });

export const ImQrBeginRequestSchema = imQrBeginSchema.meta({ id: "ImQrBeginRequest" });

export const ImSettingsRequestSchema = imSettingsSchema.meta({ id: "ImSettingsRequest" });

export const ImSetupSchema = z
  .strictObject({
    id: z.string(),
    platform: z.enum(["telegram", "feishu", "lark"]),
    status: z.enum([
      "authorizing",
      "pairing",
      "completed",
      "expired",
      "denied",
      "error",
      "cancelled",
    ]),
    expiresAt: z.number(),
    verificationUrl: z.string().optional(),
    qrDataUrl: z.string().optional(),
    pairCommand: z.string().optional(),
    botUrl: z.string().optional(),
    botName: z.string().optional(),
    error: z.string().optional(),
  })
  .meta({ id: "ImSetup" });

export const IssueSchema = z
  .strictObject({
    id: z.string(),
    agentId: z.string(),
    userId: z.string(),
    sessionId: z.string().optional(),
    title: z.string(),
    description: z.string(),
    lastRunDetail: z.string().optional(),
    verdictSummary: z.string().optional(),
    criteria: z.array(z.string().min(1).max(2000)).max(50),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    status: z.enum([
      "backlog",
      "todo",
      "queued",
      "in_progress",
      "waiting",
      "needs_input",
      "blocked",
      "in_review",
      "done",
      "cancelled",
    ]),
    running: z.boolean(),
    lastRunOutcome: z.enum(["succeeded", "failed", "cancelled", "interrupted"]).optional(),
    verdict: z.enum(["done", "needs_input", "blocked", "waiting"]).optional(),
    closedAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    queuePosition: z.number().optional(),
    queuedInstructions: z.string().optional(),
    notifyPlatform: z.enum(["telegram", "feishu", "lark"]).optional(),
  })
  .meta({ id: "Issue" });

export const IssueAttemptSchema = z
  .strictObject({
    id: z.string(),
    issueId: z.string(),
    instructions: z.string(),
    brief: z.string(),
    sessionId: z.string().nullable(),
    summary: z.string().nullable(),
    evidence: z.string().nullable(),
    outcome: z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]),
    createdAt: z.number(),
    finishedAt: z.number().nullable(),
    snapshot: z
      .strictObject({
        capturedAt: z.number(),
        warning: z.string().optional(),
        files: z.array(
          z.strictObject({
            path: z.string(),
            change: z.enum(["added", "modified", "deleted"]),
            before: z.string().nullable(),
            after: z.string().nullable(),
            omitted: z.boolean().optional(),
          }),
        ),
      })
      .nullable()
      .optional(),
  })
  .meta({ id: "IssueAttempt" });

export const IssueCreateRequestSchema = issueCreateSchema.meta({ id: "IssueCreateRequest" });

export const IssueNoteSchema = z
  .strictObject({
    id: z.string(),
    issueId: z.string(),
    body: z.string(),
    kind: z.enum(["note", "action", "result"]),
    createdAt: z.number(),
    delivery: z.enum(["queued", "delivered", "not_delivered"]).nullable().optional(),
    entryId: z.string().nullable().optional(),
  })
  .meta({ id: "IssueNote" });

export const IssueDetailSchema = z
  .strictObject({
    id: z.string(),
    agentId: z.string(),
    userId: z.string(),
    sessionId: z.string().optional(),
    title: z.string(),
    description: z.string(),
    lastRunDetail: z.string().optional(),
    verdictSummary: z.string().optional(),
    criteria: z.array(z.string().min(1).max(2000)).max(50),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    status: z.enum([
      "backlog",
      "todo",
      "queued",
      "in_progress",
      "waiting",
      "needs_input",
      "blocked",
      "in_review",
      "done",
      "cancelled",
    ]),
    running: z.boolean(),
    lastRunOutcome: z.enum(["succeeded", "failed", "cancelled", "interrupted"]).optional(),
    verdict: z.enum(["done", "needs_input", "blocked", "waiting"]).optional(),
    closedAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    attempts: z.array(IssueAttemptSchema),
    notes: z.array(IssueNoteSchema),
    queuePosition: z.number().optional(),
    queuedInstructions: z.string().optional(),
  })
  .meta({ id: "IssueDetail" });

export const IssueNoteRequestSchema = issueNoteSchema.meta({ id: "IssueNoteRequest" });

export const IssuePatchRequestSchema = issuePatchSchema.meta({ id: "IssuePatchRequest" });

export const IssueQueueMoveRequestSchema = issueQueueMoveSchema.meta({
  id: "IssueQueueMoveRequest",
});

export const IssueRunRequestSchema = issueRunSchema.meta({ id: "IssueRunRequest" });

export const KnowledgeDocumentSchema = z
  .object({
    sourceId: z.string(),
    path: z.string(),
    title: z.string(),
    content: z.string(),
    revision: z.string(),
    fromLine: z.number().int(),
    totalLines: z.number().int(),
    citation: z.string(),
  })
  .meta({ id: "KnowledgeDocument" });

export const KnowledgeHitSchema = z
  .object({
    sourceId: z.string(),
    path: z.string(),
    title: z.string(),
    revision: z.string(),
    fromLine: z.number().int(),
    totalLines: z.number().int(),
    citation: z.string(),
    excerpt: z.string(),
    score: z.number(),
    sourceName: z.string(),
  })
  .meta({ id: "KnowledgeHit" });

export const KnowledgeSourceSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    name: z.string(),
    path: z.string(),
    description: z.string(),
    createdAt: z.number().int(),
  })
  .meta({ id: "KnowledgeSource" });

export const KnowledgeOverviewSchema = z
  .object({
    embeddingModel: z.string(),
    settings: KnowledgeSettingsSchema,
    sources: z.array(KnowledgeSourceSchema),
    status: KnowledgeStatusSchema,
  })
  .meta({ id: "KnowledgeOverview" });

export const KnowledgeReadRequestSchema = knowledgeReadSchema.meta({ id: "KnowledgeReadRequest" });

export const KnowledgeSearchRequestSchema = knowledgeSearchSchema.meta({
  id: "KnowledgeSearchRequest",
});

export const KnowledgeSearchResultSchema = z
  .object({
    hits: z.array(KnowledgeHitSchema),
    mode: z.enum(["fast", "semantic", "deep"]),
    warning: z.string().optional(),
  })
  .meta({ id: "KnowledgeSearchResult" });

export const KnowledgeSourceRequestSchema = knowledgeSourceInputSchema.meta({
  id: "KnowledgeSourceRequest",
});

export const LoginRequestSchema = loginRequestSchema.meta({ id: "LoginRequest" });

export const MessageEditRequestSchema = sessionMessageEditRequestSchema.meta({
  id: "MessageEditRequest",
});

export const ModelRequestSchema = modelRefRequestSchema.meta({ id: "ModelRequest" });

export const OAuthFlowSchema = z
  .object({
    id: z.string(),
    providerConfigId: z.string(),
    provider: z.string(),
    providerName: z.string(),
    status: z.enum(["pending", "auth", "input", "success", "error"]),
  })
  .meta({ id: "OAuthFlow" });

export const OAuthInputRequestSchema = oauthInputRequestSchema.meta({ id: "OAuthInputRequest" });

export const OKSchema = z.object({ ok: z.boolean() }).meta({ id: "OK" });

export const OpenWebUIImportRequestSchema = openWebuiImportRequestSchema.meta({
  id: "OpenWebUIImportRequest",
});

export const PasswordResetRequestSchema = adminPasswordResetRequestSchema.meta({
  id: "PasswordResetRequest",
});

export const ProviderModelSchema = z
  .object({ id: z.string(), name: z.string() })
  .meta({ id: "ProviderModel" });

export const ProviderRequestSchema = providerConfigRequestSchema.meta({ id: "ProviderRequest" });

export const QuestionAnswerRequestSchema = questionAnswerSchema.meta({
  id: "QuestionAnswerRequest",
});

export const SecretAnswerRequestSchema = secretAnswerSchema.meta({ id: "SecretAnswerRequest" });

export const SessionSchema = SessionMetadataSchema.and(
  z.object({
    messages: z.array(z.object({}).meta({ "x-typescript-type": "Pi.AgentMessage" })),
    messageEntryIds: z.array(z.string()),
    olderCursor: z.string().optional(),
    observedAt: z.number().optional(),
  }),
).meta({ id: "Session" });

export const SessionSecretSchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    scope: z.enum(["session", "agent"]),
    updatedAt: z.number().int(),
  })
  .meta({ id: "SessionSecret" });

export const UserRequestSchema = z
  .strictObject({
    id: z.string(),
    sessionId: z.string(),
    kind: z.enum(["question", "secret"]),
    status: z.enum(["pending", "answered", "cancelled", "expired"]),
    delivery: z.enum(["pending", "submitted"]).nullable(),
    createdAt: z.number().int(),
    expiresAt: z.number().int(),
    question: z
      .object({
        question: z.string(),
        options: z.array(
          z.object({ id: z.string(), label: z.string(), description: z.string().optional() }),
        ),
        multiple: z.boolean(),
        allowFreeText: z.boolean(),
      })
      .optional(),
    secret: z
      .object({ name: z.string(), reason: z.string(), replaceExisting: z.boolean() })
      .optional(),
    answer: QuestionAnswerRequestSchema.optional(),
    credential: SessionSecretSchema.optional(),
  })
  .meta({ id: "UserRequest" });

export const SessionConnectionSchema = z
  .object({
    session: SessionSchema,
    userRequests: z.array(UserRequestSchema).optional(),
    runProgress: z
      .object({
        live: z
          .object({
            run: z.object({}).optional(),
            generation: z
              .object({
                attempt: z.number().int().optional(),
                message: z.object({}).optional(),
                retry: z
                  .object({ at: z.number().optional(), error: z.string().optional() })
                  .optional(),
                deferred: z.object({ pollAt: z.number().optional() }).optional(),
              })
              .optional(),
            tools: z
              .array(
                z.object({
                  callId: z.string(),
                  name: z.string(),
                  status: z.enum(["pending", "running", "done"]),
                  output: z.string().optional(),
                }),
              )
              .optional(),
            nestedTools: z
              .array(
                z.object({
                  callId: z.string(),
                  parentCallId: z.string(),
                  name: z.string(),
                  status: z.enum(["pending", "running", "done"]),
                  summary: z.object({}).optional(),
                }),
              )
              .optional(),
            compactions: z.array(z.object({})).optional(),
            compactionFailure: z.object({}).optional(),
            runFailure: z.object({}).optional(),
          })
          .describe(
            "Pi Durable live state (`pi.live`). Clients render generation.message as the streaming reply, tools as the current round's tool calls, and nestedTools as calls made by running tools.",
          )
          .optional(),
        errorMessage: z.string().optional(),
        contextPressure: z
          .object({ level: z.enum(["warning", "critical"]), message: z.string() })
          .optional(),
      })
      .describe(
        "Present while a run is active: the progress at activeRun.eventCursor. Apply later live_update ops from /api/updates to `live`.",
      )
      .meta({ "x-typescript-type": "Shared.RunProgress" })
      .optional(),
    pendingWork: z.boolean().describe("Saved Durable work awaiting resume or stop.").optional(),
    activeRun: z
      .object({ runId: z.string(), sessionId: z.string(), eventCursor: z.number().int() })
      .nullable(),
  })
  .meta({ id: "SessionConnection" });

export const SessionDraftRequestSchema = sessionDraftRequestSchema.meta({
  id: "SessionDraftRequest",
});

export const SessionPatchRequestSchema = sessionPatchRequestSchema.meta({
  id: "SessionPatchRequest",
});

export const SessionSearchResultSchema = z
  .strictObject({
    sessionId: z.string(),
    agentId: z.string(),
    title: z.string(),
    entryId: z.string().describe("Present for message matches.").optional(),
    excerpt: z.string().describe("Message snippet; empty for title matches."),
    link: z.string().describe("Session path with an entry anchor for message matches."),
  })
  .meta({ id: "SessionSearchResult" });

export const SessionTruncateRequestSchema = sessionTruncateRequestSchema.meta({
  id: "SessionTruncateRequest",
});

export const SetupRequestSchema = setupRequestSchema.meta({ id: "SetupRequest" });

export const SetupStatusSchema = z
  .object({
    needsSetup: z.boolean(),
    passwordLogin: z.boolean(),
    oidc: z.object({ providerName: z.string() }).optional(),
  })
  .meta({ id: "SetupStatus" });

export const UserProfileRequestSchema = userRequestSchema.meta({ id: "UserProfileRequest" });

export const UserRoleRequestSchema = updateUserRoleRequestSchema.meta({ id: "UserRoleRequest" });

export const PromptInputSchema = promptInputSchema.meta({ id: "PromptInput" });

export const OAuthProviderSchema = z
  .object({ id: z.string(), name: z.string(), usesCallbackServer: z.boolean().optional() })
  .meta({ id: "OAuthProvider" });

export const SessionImportResultSchema = z
  .object({ sessions: z.array(SessionSchema), skipped: z.number().int() })
  .meta({ id: "SessionImportResult" });

export const AgentTaskRunSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    scheduledFor: z.number(),
    startedAt: z.number(),
    finishedAt: z.number().optional(),
    outcome: z.enum([
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
      "missed",
      "skipped",
      "running",
    ]),
    detail: z.string().optional(),
    sessionId: z.string().optional(),
    deliveries: z.array(ImDeliverySchema).optional(),
  })
  .meta({ id: "AgentTaskRun" });

export const AgentSlashCommandSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    source: z.enum(["prompt", "skill"]),
    commandText: z.string(),
    sourcePath: z.string().optional(),
    argumentHint: z.string().optional(),
  })
  .meta({ id: "AgentSlashCommand" });

export const CollaborationConnectionSchema = collaborationConnectionSchema.meta({
  id: "CollaborationConnection",
});

export const CollaborationSummarySchema = z
  .object({
    id: z.string(),
    sourceAgentId: z.string(),
    targetAgentId: z.string(),
    sourceSessionId: z.string(),
    targetSessionId: z.string().nullable(),
    sourceIssueId: z.string().nullable(),
    targetIssueId: z.string().nullable(),
    kind: z.enum(["consult", "task"]),
    status: z.enum(["queued", "working", "answered", "failed", "cancelled"]),
    request: z.string(),
    answer: z.string().nullable(),
    createdAt: z.number(),
  })
  .meta({ id: "CollaborationSummary" });

export const HomeSummarySchema = z
  .object({
    agentId: z.string(),
    sessionId: z.string(),
    unread: z.boolean(),
    working: z.boolean(),
    needsAttention: z.boolean(),
  })
  .meta({ id: "HomeSummary" });

export const HomeStatusSchema = z
  .object({
    home: z
      .object({
        sessionId: z.string(),
        paused: z.boolean(),
        activityAt: z.number(),
        lastReadAt: z.number(),
      })
      .nullable(),
    deliveries: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        error: z.string().nullable().optional(),
        eventId: z.string().nullable().optional(),
      }),
    ),
    events: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        kind: z.string(),
        error: z.string().nullable().optional(),
        createdAt: z.number(),
      }),
    ),
  })
  .meta({ id: "HomeStatus" });

export const HomeMemoryUpkeepSchema = z
  .object({
    tidy: HomeMemoryTidyReportSchema,
    dream: HomeMemoryDreamReportSchema.nullable(),
  })
  .meta({ id: "HomeMemoryUpkeep" });

export const CollaboratorSchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    description: z.string(),
    capabilities: collaborationGrantSchema,
  })
  .meta({ id: "Collaborator" });

export const HelperSummarySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    task: z.string(),
    background: z.boolean(),
    createdAt: z.number(),
    wakeAt: z.number(),
    deadline: z.number(),
    status: z.enum(["working", "sleeping", "reporting", "done", "failed", "stopped"]),
    answer: z.string().optional(),
  })
  .meta({ id: "HelperSummary" });
