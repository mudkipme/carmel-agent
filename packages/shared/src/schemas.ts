import { z } from "zod";

export const emptyStringToUndefined = (value: unknown) => (value === "" ? undefined : value);
export const optionalStringSchema = z.preprocess(emptyStringToUndefined, z.string().optional());
export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelInputSchema = z.array(z.enum(["text", "image"]));
/**
 * Per-level provider value, or null to mark a level unsupported. Pi gates
 * `xhigh`/`max` on a key being present here, so this is what makes those levels
 * selectable at all.
 */
export const thinkingLevelMapSchema = z.object({
  off: z.string().nullable().optional(),
  minimal: z.string().nullable().optional(),
  low: z.string().nullable().optional(),
  medium: z.string().nullable().optional(),
  high: z.string().nullable().optional(),
  xhigh: z.string().nullable().optional(),
  max: z.string().nullable().optional(),
}).strict();
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
export const loginRequestSchema = z.object({
  username: optionalStringSchema.transform((value) => value?.trim()),
  password: optionalStringSchema,
}).strict();
export const accountUpdateRequestSchema = z.object({
  currentPassword: optionalStringSchema,
  email: z.string(),
  newPassword: optionalStringSchema,
}).strict();
export const setupRequestSchema = z.object({
  username: z.string(),
  password: z.string(),
  email: optionalStringSchema,
  name: optionalStringSchema,
}).strict();
export const createUserRequestSchema = z.object({
  username: z.string(),
  email: z.string(),
  password: z.string(),
  name: optionalStringSchema,
  role: z.enum(["admin", "user"]).optional(),
}).strict();
export const updateUserRoleRequestSchema = z.object({ role: z.enum(["admin", "user"]) }).strict();
export const adminPasswordResetRequestSchema = z.object({ password: z.string() }).strict();
export const userRequestSchema = z.object({
  name: z.string(),
  fastTaskModelRefId: optionalStringSchema,
}).strict();
export const modelRefRequestSchema = z.object({
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
}).strict();
export const providerConfigRequestSchema = z.object({
  label: z.string(),
  provider: z.string(),
  authType: z.enum(["api_key", "oauth"]).optional(),
  apiKey: optionalStringSchema,
  baseUrl: optionalStringSchema,
}).strict();
export const oauthInputRequestSchema = z.object({ value: optionalStringSchema }).strict();
export const agentConfigRequestSchema = z.object({
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
  defaultModelRefId: z.string(),
  defaultThinkingLevel: thinkingLevelSchema.default("off"),
}).strict();
export const promptInputSchema = z.object({
  text: z.string(),
  images: z.array(imageContentSchema).optional(),
}).strict();
export const agentRunRequestSchema = z.object({
  sessionId: optionalStringSchema,
  modelRefId: optionalStringSchema,
  thinkingLevel: thinkingLevelSchema.optional(),
  promptInput: promptInputSchema.optional(),
}).strict();
export const sessionDraftRequestSchema = z.object({
  agentId: z.string(),
  modelRefId: z.string(),
  thinkingLevel: thinkingLevelSchema.optional(),
  title: optionalStringSchema,
}).strict();
export const sessionPatchRequestSchema = z.object({
  title: z.string().optional(),
  modelRefId: z.string().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  pinnedAt: z.number().finite().nullable().optional(),
}).strict();
export const forkSessionRequestSchema = z.object({ entryId: z.string().min(1) }).strict();
export const sessionTruncateRequestSchema = z.object({
  entryId: z.string().min(1),
  thinkingLevel: thinkingLevelSchema.optional(),
}).strict();
export const sessionMessageEditRequestSchema = z.object({
  content: z.string(),
  truncate: z.boolean().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  removedImageIndexes: z.array(z.number().int().nonnegative()).optional(),
  removedAttachmentIds: z.array(z.string()).optional(),
}).strict();
export const openWebuiImportRequestSchema = z.object({
  agentId: z.string(),
  modelRefId: z.string(),
  thinkingLevel: thinkingLevelSchema.optional(),
  source: z.unknown(),
}).strict();
export const fileContentRequestSchema = z.object({
  path: optionalStringSchema,
  content: z.string().optional(),
}).strict();
export const createFileEntryRequestSchema = z.object({
  path: optionalStringSchema,
  type: z.enum(["file", "directory"]).optional(),
}).strict();
export const renameFileEntryRequestSchema = z.object({
  path: optionalStringSchema,
  newPath: optionalStringSchema,
}).strict();

export type AgentMount = z.infer<typeof agentMountSchema>;
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
