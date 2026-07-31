import { z } from "zod";

export const emptyStringToUndefined = (value: unknown) => (value === "" ? undefined : value);
export const optionalStringSchema = z.preprocess(emptyStringToUndefined, z.string().optional());
export const timestampSchema = z.number().finite().default(() => Date.now());
export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const modelInputSchema = z.array(z.enum(["text", "image"]));
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

export const loginRequestSchema = z.object({
  username: optionalStringSchema.transform((value) => value?.trim()),
  password: optionalStringSchema,
});
export const accountUpdateRequestSchema = z.object({
  currentPassword: optionalStringSchema,
  email: z.string(),
  newPassword: optionalStringSchema,
});
export const setupRequestSchema = z.object({
  username: z.string(),
  password: z.string(),
  email: optionalStringSchema,
  name: optionalStringSchema,
});
export const createUserRequestSchema = z.object({
  username: z.string(),
  email: z.string(),
  password: z.string(),
  name: optionalStringSchema,
  role: z.enum(["admin", "user"]).optional(),
});
export const updateUserRoleRequestSchema = z.object({ role: z.enum(["admin", "user"]) });
export const adminPasswordResetRequestSchema = z.object({ password: z.string() });
export const userRequestSchema = z.object({
  id: z.string(),
  username: optionalStringSchema,
  name: z.string(),
  email: z.string(),
  fastTaskModelRefId: optionalStringSchema,
});
export const modelRefRequestSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
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
});
export const providerConfigRequestSchema = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string(),
  provider: z.string(),
  authType: z.enum(["api_key", "oauth"]).optional(),
  apiKey: optionalStringSchema,
  hasApiKey: z.boolean().optional(),
  hasOAuth: z.boolean().optional(),
  baseUrl: optionalStringSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const oauthInputRequestSchema = z.object({ value: optionalStringSchema });
export const agentConfigRequestSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
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
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const promptInputSchema = z.object({
  text: z.string(),
  images: z.array(imageContentSchema).optional(),
});
export const agentRunRequestSchema = z.object({
  sessionId: optionalStringSchema,
  modelRefId: optionalStringSchema,
  thinkingLevel: thinkingLevelSchema.optional(),
  promptInput: promptInputSchema.optional(),
});
export const sessionDraftRequestSchema = z.object({
  agentId: z.string(),
  modelRefId: z.string(),
  thinkingLevel: thinkingLevelSchema.optional(),
  title: optionalStringSchema,
});
export const sessionPatchRequestSchema = z.object({
  title: z.string().optional(),
  modelRefId: z.string().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  pinnedAt: z.number().finite().nullable().optional(),
}).partial();
export const forkSessionRequestSchema = z.object({ entryId: z.string().min(1) });
export const sessionTruncateRequestSchema = z.object({
  entryId: z.string().min(1),
  thinkingLevel: thinkingLevelSchema.optional(),
});
export const sessionMessageEditRequestSchema = z.object({
  content: z.string(),
  truncate: z.boolean().optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  removedImageIndexes: z.array(z.number().int().nonnegative()).optional(),
  removedAttachmentIds: z.array(z.string()).optional(),
});
export const openWebuiImportRequestSchema = z.object({
  agentId: z.string(),
  modelRefId: z.string(),
  thinkingLevel: thinkingLevelSchema.optional(),
  source: z.unknown(),
});
export const fileContentRequestSchema = z.object({
  path: optionalStringSchema,
  content: z.string().optional(),
});
export const createFileEntryRequestSchema = z.object({
  path: optionalStringSchema,
  type: z.enum(["file", "directory"]).optional(),
});
export const renameFileEntryRequestSchema = z.object({
  path: optionalStringSchema,
  newPath: optionalStringSchema,
});
