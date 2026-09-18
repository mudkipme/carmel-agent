import { z } from "zod";
import * as S from "../src/schemas.ts";

const requestSchemas = {
  LoginRequest: S.loginRequestSchema,
  AccountRequest: S.accountUpdateRequestSchema,
  SetupRequest: S.setupRequestSchema,
  CreateUserRequest: S.createUserRequestSchema,
  UserRoleRequest: S.updateUserRoleRequestSchema,
  PasswordResetRequest: S.adminPasswordResetRequestSchema,
  UserProfileRequest: S.userRequestSchema,
  ModelRequest: S.modelRefRequestSchema,
  ProviderRequest: S.providerConfigRequestSchema,
  OAuthInputRequest: S.oauthInputRequestSchema,
  AgentRequest: S.agentConfigRequestSchema,
  AgentSecretRequest: S.agentSecretWriteSchema,
  AgentTaskCreateRequest: S.agentTaskCreateSchema,
  AgentTaskPatchRequest: S.agentTaskPatchSchema,
  IssueCreateRequest: S.issueCreateSchema,
  IssuePatchRequest: S.issuePatchSchema,
  AgentRunRequest: S.agentRunRequestSchema,
  SessionDraftRequest: S.sessionDraftRequestSchema,
  SessionPatchRequest: S.sessionPatchRequestSchema,
  ForkSessionRequest: S.forkSessionRequestSchema,
  SessionTruncateRequest: S.sessionTruncateRequestSchema,
  MessageEditRequest: S.sessionMessageEditRequestSchema,
  OpenWebUIImportRequest: S.openWebuiImportRequestSchema,
  FileContentRequest: S.fileContentRequestSchema,
  FileCreateRequest: S.createFileEntryRequestSchema,
  FileRenameRequest: S.renameFileEntryRequestSchema,
  FileBatchRequest: S.fileBatchRequestSchema,
} as const;

const schemas = Object.fromEntries(
  Object.entries(requestSchemas).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, {
      target: "openapi-3.0",
      unrepresentable: "any",
    }),
  ]),
);

process.stdout.write(`${JSON.stringify({ components: { schemas } }, null, 2)}\n`);
