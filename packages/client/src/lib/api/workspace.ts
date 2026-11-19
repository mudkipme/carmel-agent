import type {
  ApiKey,
  ApiKeyCreated,
  CreateUserRequest,
  Environment,
  EnvironmentCommand,
  EnvironmentSecret,
  ModelRef,
  ModelRefCommand,
  OAuthLoginFlowState,
  OAuthProviderSummary,
  ProviderConfig,
  ProviderConfigCommand,
  ProviderModelSummary,
  SetupStatus,
  User,
  UserRole,
  UserUpdateRequest,
} from "@carmel-agent/shared";
import { call, type BootstrapPayload } from "./core.ts";

export const workspaceApi = {
  bootstrap: (): Promise<BootstrapPayload> => call("getBootstrap"),
  login: (username: string, password: string): Promise<BootstrapPayload> =>
    call("login", { body: { username, password } }),
  logout: (): Promise<{ ok: boolean }> => call("logout"),
  setupStatus: (): Promise<SetupStatus> => call("getAuthStatus"),
  setup: (input: {
    username: string;
    password: string;
    email?: string;
    name?: string;
  }): Promise<BootstrapPayload> => call("setup", { body: input }),
  listUsers: (): Promise<User[]> => call("listUsers"),
  createUser: (input: CreateUserRequest): Promise<User> => call("createUser", { body: input }),
  updateUserRole: (userId: string, role: UserRole): Promise<User> =>
    call("updateUserRole", { path: { id: userId }, body: { role } }),
  resetUserPassword: (userId: string, password: string): Promise<{ ok: boolean }> =>
    call("resetUserPassword", { path: { id: userId }, body: { password } }),
  deleteUser: (userId: string): Promise<{ ok: boolean }> =>
    call("deleteUser", { path: { id: userId } }),
  updateAccount: (currentPassword: string, email: string, newPassword?: string): Promise<User> =>
    call("updateAccount", { body: { currentPassword, email, newPassword } }),
  listApiKeys: (): Promise<ApiKey[]> => call("listApiKeys"),
  createApiKey: (name: string): Promise<ApiKeyCreated> => call("createApiKey", { body: { name } }),
  deleteApiKey: (apiKeyId: string): Promise<{ ok: boolean }> =>
    call("deleteApiKey", { path: { id: apiKeyId } }),
  upsertUser: (userId: string, input: UserUpdateRequest): Promise<User> =>
    call("updateUserProfile", { path: { id: userId }, body: input }),
  upsertModelRef: (modelId: string, input: ModelRefCommand): Promise<ModelRef> =>
    call("upsertModel", { path: { id: modelId }, body: input }),
  deleteModelRef: (modelRefId: string): Promise<BootstrapPayload> =>
    call("deleteModel", { path: { id: modelRefId } }),
  upsertProviderConfig: (
    providerConfigId: string,
    input: ProviderConfigCommand,
  ): Promise<ProviderConfig> =>
    call("upsertProviderConfig", { path: { id: providerConfigId }, body: input }),
  deleteProviderConfig: (providerConfigId: string): Promise<BootstrapPayload> =>
    call("deleteProviderConfig", { path: { id: providerConfigId } }),
  listProviderModels: (
    providerConfigId: string,
    options: { refresh?: boolean } = {},
  ): Promise<ProviderModelSummary[]> =>
    call("listProviderModels", {
      path: { id: providerConfigId },
      query: { refresh: options.refresh || undefined },
    }),
  getOAuthProviders: (): Promise<OAuthProviderSummary[]> => call("listOAuthProviders"),
  startProviderOAuthLogin: (providerConfigId: string): Promise<OAuthLoginFlowState> =>
    call("startProviderOAuth", { path: { id: providerConfigId } }),
  getOAuthLoginFlow: (flowId: string): Promise<OAuthLoginFlowState> =>
    call("getOAuthFlow", { path: { id: flowId } }),
  submitOAuthLoginFlowInput: (flowId: string, value: string): Promise<OAuthLoginFlowState> =>
    call("submitOAuthInput", { path: { id: flowId }, body: { value } }),
  listEnvironments: (signal?: AbortSignal): Promise<Environment[]> =>
    call("listEnvironments", { signal, cache: "no-store" }),
  createEnvironment: (input: EnvironmentCommand): Promise<Environment> =>
    call("createEnvironment", { body: input }),
  updateEnvironment: (environmentId: string, input: EnvironmentCommand): Promise<Environment> =>
    call("updateEnvironment", { path: { id: environmentId }, body: input }),
  deleteEnvironment: (environmentId: string): Promise<{ ok: boolean }> =>
    call("deleteEnvironment", { path: { id: environmentId } }),
  listEnvironmentSecrets: (environmentId: string): Promise<EnvironmentSecret[]> =>
    call("listEnvironmentSecrets", { path: { environmentId } }),
  environmentWorkspaceDotEnvStatus: (
    environmentId: string,
    agentId: string,
  ): Promise<{ available: boolean }> =>
    call("getEnvironmentWorkspaceDotEnvStatus", {
      path: { environmentId },
      query: { agent: agentId },
    }),
  importEnvironmentWorkspaceDotEnv: (
    environmentId: string,
    agentId: string,
  ): Promise<{ imported: number; skippedExisting: number; skippedInvalid: number }> =>
    call("importEnvironmentWorkspaceDotEnv", {
      path: { environmentId },
      query: { agent: agentId },
    }),
  writeEnvironmentSecret: (
    environmentId: string,
    name: string,
    value: string,
  ): Promise<EnvironmentSecret> =>
    call("writeEnvironmentSecret", { path: { environmentId, name }, body: { value } }),
  deleteEnvironmentSecret: (environmentId: string, name: string): Promise<{ ok: boolean }> =>
    call("deleteEnvironmentSecret", { path: { environmentId, name } }),
};
