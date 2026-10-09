import { z } from "zod";

export const emptyStringToUndefined = (value: unknown) => (value === "" ? undefined : value);
export const optionalStringSchema = z.preprocess(emptyStringToUndefined, z.string().optional());
export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const modelInputSchema = z.array(z.enum(["text", "image"]));
/**
 * Per-level provider value, or null to mark a level unsupported. Pi gates
 * `xhigh`/`max` on a key being present here, so this is what makes those levels
 * selectable at all.
 */
export const thinkingLevelMapSchema = z
  .object({
    off: z.string().nullable().optional(),
    minimal: z.string().nullable().optional(),
    low: z.string().nullable().optional(),
    medium: z.string().nullable().optional(),
    high: z.string().nullable().optional(),
    xhigh: z.string().nullable().optional(),
    max: z.string().nullable().optional(),
  })
  .strict();
export const promptTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
});
export const agentMountSchema = z.object({
  source: z.string().min(1),
  target: optionalStringSchema,
  readOnly: z.boolean().optional(),
});
/**
 * A secret's name is the environment variable the sandbox will export, so it
 * has to be a valid shell identifier before it is anything else.
 */
export const agentSecretNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names the sandbox sets itself, or that change how the shell and dynamic
 * loader behave. A secret is a credential handed to a command, not a lever on
 * the environment that runs it -- letting one land on `PATH` or `LD_PRELOAD`
 * would turn "store a token" into "replace every binary the agent runs".
 */
export const reservedAgentSecretNames = new Set([
  "HOME",
  "PATH",
  "TERM",
  "LANG",
  "IFS",
  "ENV",
  "BASH_ENV",
  "BASHOPTS",
  "SHELLOPTS",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
]);

/** The one place the name rule lives, so the browser and the server agree. */
export function agentSecretNameError(name: string) {
  if (!name) return "A secret name is required.";
  if (name.length > 128) return "Secret names are limited to 128 characters.";
  if (!agentSecretNamePattern.test(name)) {
    return "Secret names must start with a letter or underscore and contain only letters, digits, and underscores.";
  }
  if (reservedAgentSecretNames.has(name))
    return `${name} is set by the sandbox and cannot be used as a secret.`;
  return undefined;
}

export const agentSecretWriteSchema = z.object({ value: z.string().min(1).max(8192) }).strict();
export const apiKeyCreateSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();

export const agentPermissionsSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  edit: z.boolean(),
  bash: z.boolean(),
  network: z.boolean(),
});
export const imageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

// Command DTOs are deliberately narrower than response/domain objects. IDs are
// route parameters, while ownership and timestamps always belong to the server.
export const loginRequestSchema = z
  .object({
    username: optionalStringSchema.transform((value) => value?.trim()),
    password: optionalStringSchema,
  })
  .strict();
export const accountUpdateRequestSchema = z
  .object({
    currentPassword: optionalStringSchema,
    email: z.string(),
    newPassword: optionalStringSchema,
  })
  .strict();
export const setupRequestSchema = z
  .object({
    username: z.string(),
    password: z.string(),
    email: optionalStringSchema,
    name: optionalStringSchema,
  })
  .strict();
export const createUserRequestSchema = z
  .object({
    username: z.string(),
    email: z.string(),
    password: z.string(),
    name: optionalStringSchema,
    role: z.enum(["admin", "user"]).optional(),
  })
  .strict();
export const updateUserRoleRequestSchema = z.object({ role: z.enum(["admin", "user"]) }).strict();
export const adminPasswordResetRequestSchema = z.object({ password: z.string() }).strict();
export const userRequestSchema = z
  .object({
    name: z.string(),
    fastTaskModelRefId: optionalStringSchema,
  })
  .strict();
export const modelRefRequestSchema = z
  .object({
    shared: z.boolean().default(false),
    label: z.string(),
    provider: z.string(),
    providerConfigId: optionalStringSchema,
    modelId: z.string(),
    api: optionalStringSchema,
    baseUrl: optionalStringSchema,
    contextWindow: z.number().finite().optional(),
    maxTokens: z.number().finite().optional(),
    reasoning: z.boolean().optional(),
    input: modelInputSchema.optional(),
    thinkingLevelMap: thinkingLevelMapSchema.optional(),
  })
  .strict();
export const providerConfigRequestSchema = z
  .object({
    label: z.string(),
    provider: z.string(),
    authType: z.enum(["api_key", "oauth"]).optional(),
    apiKey: optionalStringSchema,
    baseUrl: optionalStringSchema,
  })
  .strict();
export const oauthInputRequestSchema = z.object({ value: optionalStringSchema }).strict();
const mcpServerBase = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
  /** Omitted exposes all tools; an empty list exposes none. */
  tools: z.array(z.string().min(1)).optional(),
};
const mcpStringMap = z.record(
  z.string().min(1),
  z.string().refine((value) => !value.includes("\0")),
);
export const agentMcpServerSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...mcpServerBase,
      transport: z.literal("http"),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      }, "Use an HTTP(S) URL without embedded credentials."),
      headers: mcpStringMap.default({}),
    })
    .strict(),
  z
    .object({
      ...mcpServerBase,
      transport: z.literal("stdio"),
      command: z
        .string()
        .trim()
        .min(1)
        .refine((value) => !value.includes("\0")),
      args: z.array(z.string().refine((value) => !value.includes("\0"))).default([]),
      env: mcpStringMap.default({}),
    })
    .strict(),
]);
export type AgentMcpServer = z.infer<typeof agentMcpServerSchema>;
export const codemodeCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  status: z.enum(["running", "ok", "error", "cancelled"]),
  durationMs: z.number().nonnegative(),
});
export const codemodeCallsSchema = z.array(codemodeCallSchema);
export type CodemodeCallInfo = z.infer<typeof codemodeCallSchema>;
export const agentMcpServersSchema = z
  .array(agentMcpServerSchema)
  .max(20)
  .superRefine((servers, ctx) => {
    const ids = new Set<string>();
    servers.forEach((server, index) => {
      if (ids.has(server.id))
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Server IDs must be unique.",
        });
      ids.add(server.id);
    });
  });
export const agentConfigRequestSchema = z
  .object({
    shared: z.boolean().default(false),
    name: z.string(),
    description: z.string(),
    workingDirMode: z.enum(["default", "manual"]).default("default"),
    workingDir: z.string(),
    defaultWorkingDir: optionalStringSchema,
    mounts: z.array(agentMountSchema).default([]),
    systemPrompt: z.string(),
    promptTemplates: z.array(promptTemplateSchema),
    permissions: agentPermissionsSchema,
    codemodeEnabled: z.boolean().default(false),
    mcpServers: agentMcpServersSchema.default([]),
    defaultModelRefId: z.string(),
    defaultThinkingLevel: thinkingLevelSchema.default("off"),
  })
  .strict();
export const agentTaskScheduleSchema = z.object({
  scheduleKind: z.enum(["cron", "interval", "once"]),
  scheduleValue: z.string().min(1),
  timezone: optionalStringSchema,
});
export const agentTaskCreateSchema = agentTaskScheduleSchema
  .extend({
    name: z.string().min(1),
    prompt: z.string().min(1),
    modelRefId: optionalStringSchema,
    thinkingLevel: thinkingLevelSchema.optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict();
export const agentTaskPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    modelRefId: optionalStringSchema,
    thinkingLevel: thinkingLevelSchema.optional(),
    scheduleKind: z.enum(["cron", "interval", "once"]).optional(),
    scheduleValue: z.string().min(1).optional(),
    timezone: optionalStringSchema,
    status: z.enum(["active", "paused"]).optional(),
  })
  .strict();
export type AgentTaskCreateCommand = z.infer<typeof agentTaskCreateSchema>;
export type AgentTaskPatchCommand = z.infer<typeof agentTaskPatchSchema>;

const issueBriefFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(40_000),
  criteria: z.array(z.string().trim().min(1).max(2_000)).max(50),
  priority: z.enum(["low", "normal", "high", "urgent"]),
};
export const issueCreateSchema = z
  .object({
    ...issueBriefFields,
    criteria: issueBriefFields.criteria.optional(),
    priority: issueBriefFields.priority.optional(),
    status: z.enum(["backlog", "todo"]).optional(),
    queue: z.boolean().optional(),
  })
  .strict();
export const issuePatchSchema = z
  .object({
    ...issueBriefFields,
    status: z.enum(["backlog", "todo"]).optional(),
  })
  .partial()
  .strict();
export const issueRunSchema = z
  .object({
    instructions: z.string().trim().max(20_000).optional(),
    modelRefId: optionalStringSchema,
    thinkingLevel: thinkingLevelSchema.optional(),
    fresh: z.boolean().optional(),
  })
  .strict();
export const issueQueueMoveSchema = z.object({ direction: z.enum(["up", "down"]) }).strict();
export const issueNoteSchema = z.object({ body: z.string().trim().min(1).max(20_000) }).strict();
export type IssueCreateCommand = z.infer<typeof issueCreateSchema>;
export type IssuePatchCommand = z.infer<typeof issuePatchSchema>;
export type IssueRunCommand = z.infer<typeof issueRunSchema>;

export const promptInputSchema = z
  .object({
    text: z.string(),
    images: z.array(imageContentSchema).optional(),
  })
  .strict();
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Use a valid IANA time zone, such as Asia/Singapore.");
export const agentRunRequestSchema = z
  .object({
    sessionId: optionalStringSchema,
    modelRefId: optionalStringSchema,
    thinkingLevel: thinkingLevelSchema.optional(),
    promptInput: promptInputSchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();
export const sessionDraftRequestSchema = z
  .object({
    agentId: z.string(),
    modelRefId: z.string(),
    thinkingLevel: thinkingLevelSchema.optional(),
    title: optionalStringSchema,
  })
  .strict();
export const sessionPatchRequestSchema = z
  .object({
    title: z.string().optional(),
    modelRefId: z.string().optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    pinnedAt: z.number().finite().nullable().optional(),
    archivedAt: z.number().finite().nullable().optional(),
    /** Only ever cleared: moves a task run's session into the session list. */
    taskId: z.null().optional(),
  })
  .strict();
export const forkSessionRequestSchema = z.object({ entryId: z.string().min(1) }).strict();
export const sessionTruncateRequestSchema = z
  .object({
    entryId: z.string().min(1),
    thinkingLevel: thinkingLevelSchema.optional(),
  })
  .strict();
export const sessionMessageEditRequestSchema = z
  .object({
    content: z.string(),
    truncate: z.boolean().optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    removedImageIndexes: z.array(z.number().int().nonnegative()).optional(),
  })
  .strict();
export const openWebuiImportRequestSchema = z
  .object({
    agentId: z.string(),
    modelRefId: z.string(),
    thinkingLevel: thinkingLevelSchema.optional(),
    source: z.unknown(),
  })
  .strict();
export const fileContentRequestSchema = z
  .object({
    path: optionalStringSchema,
    content: z.string().optional(),
  })
  .strict();
export const createFileEntryRequestSchema = z
  .object({
    path: optionalStringSchema,
    type: z.enum(["file", "directory"]).optional(),
  })
  .strict();
export const renameFileEntryRequestSchema = z
  .object({
    path: optionalStringSchema,
    newPath: optionalStringSchema,
  })
  .strict();
/**
 * One request per user gesture rather than per path: a batch delete, cut/paste
 * or copy/paste in the file manager reports partial failure per entry instead
 * of leaving the client to reconcile a burst of independent requests.
 */
export const fileBatchRequestSchema = z
  .object({
    operation: z.enum(["delete", "move", "copy"]),
    paths: z.array(z.string().min(1)).min(1).max(500),
    destination: optionalStringSchema,
  })
  .strict();

export type AgentFileBatchCommand = z.infer<typeof fileBatchRequestSchema>;
export type AgentFileBatchOperation = AgentFileBatchCommand["operation"];
export type AgentMount = z.infer<typeof agentMountSchema>;
export type AgentSecretWriteCommand = z.infer<typeof agentSecretWriteSchema>;
export type ApiKeyCreateCommand = z.infer<typeof apiKeyCreateSchema>;
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;
export type AgentThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type PromptTemplate = z.infer<typeof promptTemplateSchema>;
export type PromptInput = z.infer<typeof promptInputSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AccountUpdateRequest = z.infer<typeof accountUpdateRequestSchema>;
export type SetupRequest = z.infer<typeof setupRequestSchema>;
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type UpdateUserRoleRequest = z.infer<typeof updateUserRoleRequestSchema>;
export type AdminPasswordResetRequest = z.infer<typeof adminPasswordResetRequestSchema>;
export type UserUpdateRequest = z.infer<typeof userRequestSchema>;
export type ModelRefCommand = z.infer<typeof modelRefRequestSchema>;
export type ProviderConfigCommand = z.infer<typeof providerConfigRequestSchema>;
export type AgentConfigCommand = z.infer<typeof agentConfigRequestSchema>;
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;
export type SessionDraft = z.infer<typeof sessionDraftRequestSchema>;
export type SessionPatch = z.infer<typeof sessionPatchRequestSchema>;
export type OpenWebuiImportRequest = z.infer<typeof openWebuiImportRequestSchema>;
