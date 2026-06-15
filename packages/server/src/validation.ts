import { zValidator } from "@hono/zod-validator";
import { z, ZodError } from "zod";

const emptyStringToUndefined = (value: unknown) => (value === "" ? undefined : value);
const optionalString = z.preprocess(emptyStringToUndefined, z.string().optional());
const timestamp = z.number().finite().default(() => Date.now());
const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const modelInput = z.array(z.enum(["text", "image"]));
const promptTemplate = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
});
const agentMount = z.object({
  source: z.string().min(1),
  target: optionalString,
  readOnly: z.boolean().optional(),
});
const permissions = z.object({
  read: z.boolean(),
  write: z.boolean(),
  edit: z.boolean(),
  bash: z.boolean(),
  network: z.boolean(),
});
const imageContent = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

export const loginRequestSchema = z.object({
  username: optionalString.transform((value) => value?.trim()),
  password: optionalString,
});

export const passwordRequestSchema = z.object({
  currentPassword: optionalString,
  newPassword: optionalString,
});

export const userRequestSchema = z.object({
  id: z.string(),
  username: optionalString,
  name: z.string(),
  email: z.string(),
  fastTaskModelRefId: optionalString,
});

export const modelRefRequestSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  shared: z.boolean().default(false),
  label: z.string(),
  provider: z.string(),
  providerConfigId: optionalString,
  modelId: z.string(),
  api: optionalString,
  baseUrl: optionalString,
  contextWindow: z.number().finite().optional(),
  maxTokens: z.number().finite().optional(),
  reasoning: z.boolean().optional(),
  input: modelInput.optional(),
});

export const providerConfigRequestSchema = z.object({
  id: z.string(),
  userId: z.string(),
  label: z.string(),
  provider: z.string(),
  authType: z.enum(["api_key", "oauth"]).optional(),
  apiKey: optionalString,
  hasApiKey: z.boolean().optional(),
  hasOAuth: z.boolean().optional(),
  baseUrl: optionalString,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const oauthInputRequestSchema = z.object({
  value: optionalString,
});

export const agentConfigRequestSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  shared: z.boolean().default(false),
  name: z.string(),
  description: z.string(),
  workingDirMode: z.enum(["default", "manual"]).default("manual"),
  workingDir: z.string(),
  defaultWorkingDir: optionalString,
  mounts: z.array(agentMount).default([]),
  systemPrompt: z.string(),
  promptTemplates: z.array(promptTemplate),
  permissions,
  defaultModelRefId: z.string(),
  defaultThinkingLevel: thinkingLevel.default("off"),
  createdAt: timestamp,
  updatedAt: timestamp,
});

const promptInput = z.object({
  text: z.string(),
  images: z.array(imageContent).optional(),
});

export const agentRunRequestSchema = z.object({
  sessionId: optionalString,
  modelRefId: optionalString,
  thinkingLevel: thinkingLevel.optional(),
  promptInput: promptInput.optional(),
});

export const sessionDraftRequestSchema = z.object({
  agentId: z.string(),
  modelRefId: z.string(),
  thinkingLevel: thinkingLevel.optional(),
  title: optionalString,
});

export const sessionPatchRequestSchema = z
  .object({
    title: z.string().optional(),
    modelRefId: z.string().optional(),
    thinkingLevel: thinkingLevel.optional(),
    pinnedAt: z.number().finite().nullable().optional(),
  })
  .partial();

export const forkSessionRequestSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
});

export const sessionTruncateRequestSchema = z.object({
  messageIndex: z.number().int().nonnegative(),
  thinkingLevel: thinkingLevel.optional(),
});

export const sessionMessageEditRequestSchema = z.object({
  content: z.string(),
  truncate: z.boolean().optional(),
  thinkingLevel: thinkingLevel.optional(),
});

export const openWebuiImportRequestSchema = z.object({
  agentId: z.string(),
  modelRefId: z.string(),
  thinkingLevel: thinkingLevel.optional(),
  source: z.unknown(),
});

export const fileContentRequestSchema = z.object({
  path: optionalString,
  content: z.string().optional(),
});

export const createFileEntryRequestSchema = z.object({
  path: optionalString,
  type: z.enum(["file", "directory"]).optional(),
});

export const renameFileEntryRequestSchema = z.object({
  path: optionalString,
  newPath: optionalString,
});

export function jsonValidator<TSchema extends z.ZodType>(schema: TSchema) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) return c.json({ error: validationErrorMessage(result.error) }, 400);
  });
}

export function isValidationError(error: unknown) {
  return error instanceof ZodError;
}

export function validationErrorMessage(error: unknown) {
  if (!(error instanceof ZodError)) return "Invalid request body.";
  const issue = error.issues[0];
  if (!issue) return "Invalid request body.";
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
