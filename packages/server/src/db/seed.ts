import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AgentConfig, AgentPermissions, ModelRef, ProviderConfig, Session, User } from "@carmel-agent/shared";
import type BetterSqlite3 from "better-sqlite3";

export const now = () => Date.now();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

const defaultPermissions: AgentPermissions = {
  read: true,
  write: true,
  edit: true,
  bash: false,
  network: false,
};

export const defaultUser: User = {
  id: "user_self",
  name: "Local User",
  email: "user@local",
  role: "user",
};

const provider = getBuiltinProviders()[0] ?? "anthropic";
const providerModels = getBuiltinModels(provider as never);
const model = providerModels[0] ?? getBuiltinModel("anthropic" as never, "claude-sonnet-4-20250514" as never);

export const defaultModelRef: ModelRef = {
  id: "model_default",
  ownerUserId: defaultUser.id,
  shared: false,
  label: model?.name ?? "Claude Sonnet",
  provider,
  providerConfigId: "provider_default",
  modelId: model?.id ?? "claude-sonnet-4-20250514",
  api: model?.api,
  contextWindow: model?.contextWindow,
  maxTokens: model?.maxTokens,
  reasoning: model?.reasoning,
  input: model?.input ?? ["text"],
};

export const defaultProviderConfig: ProviderConfig = {
  id: "provider_default",
  userId: defaultUser.id,
  label: `${provider} default`,
  provider,
  createdAt: now(),
  updatedAt: now(),
};

export const defaultAgent: AgentConfig = {
  id: "agent_self",
  ownerUserId: defaultUser.id,
  shared: false,
  name: "Local Agent",
  description: "Default local coding and research agent",
  workingDirMode: "default",
  workingDir: "agents/agent_self/workspace",
  defaultWorkingDir: "agents/agent_self/workspace",
  mounts: [],
  systemPrompt:
    "You are Carmel, a pragmatic local agent harness. Work carefully, explain tradeoffs concisely, and preserve user intent.",
  promptTemplates: [
    {
      id: "template_review",
      name: "Review",
      body: "Review this change for behavioral risks, regressions, and missing tests.",
    },
    {
      id: "template_plan",
      name: "Plan",
      body: "Create a concrete implementation plan with risks and verification steps.",
    },
  ],
  permissions: defaultPermissions,
  defaultModelRefId: defaultModelRef.id,
  defaultThinkingLevel: "off",
  createdAt: now(),
  updatedAt: now(),
};

// The seeded session starts with an empty Pi-native tree.
export const defaultSession: Omit<Session, "messages" | "messageEntryIds"> = {
  id: "session_initial",
  title: "Initial session",
  userId: defaultUser.id,
  agentId: defaultAgent.id,
  modelRefId: defaultModelRef.id,
  thinkingLevel: "off",
  revision: 0,
  createdAt: now(),
  updatedAt: now(),
};

/** Insert the initial object graph only; existing data is left intact. */
export function seedDatabase(sqlite: BetterSqlite3.Database) {
  const existing = (sqlite.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
  if (existing > 0) return;
  const timestamp = now();
  sqlite.exec("BEGIN");
  try {
    sqlite.prepare(`
      INSERT INTO users
        (id, username, password_hash, name, email, role, fast_task_model_ref_id, created_at, updated_at)
      VALUES (?, NULL, NULL, ?, ?, ?, NULL, ?, ?)
    `).run(defaultUser.id, defaultUser.name, defaultUser.email, defaultUser.role, timestamp, timestamp);
    sqlite.prepare(`
      INSERT INTO provider_configs
        (id, user_id, label, provider, auth_type, api_key, oauth_credential, base_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'api_key', NULL, NULL, ?, ?, ?)
    `).run(
      defaultProviderConfig.id,
      defaultProviderConfig.userId,
      defaultProviderConfig.label,
      defaultProviderConfig.provider,
      defaultProviderConfig.baseUrl ?? null,
      timestamp,
      timestamp,
    );
    sqlite.prepare(`
      INSERT INTO model_refs
        (id, owner_user_id, shared, label, provider, provider_config_id, model_id, api, base_url,
         context_window, max_tokens, reasoning, input, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      defaultModelRef.id,
      defaultModelRef.ownerUserId,
      Number(defaultModelRef.shared),
      defaultModelRef.label,
      defaultModelRef.provider,
      defaultModelRef.providerConfigId ?? null,
      defaultModelRef.modelId,
      defaultModelRef.api ?? null,
      defaultModelRef.baseUrl ?? null,
      defaultModelRef.contextWindow ?? null,
      defaultModelRef.maxTokens ?? null,
      Number(defaultModelRef.reasoning ?? false),
      JSON.stringify(defaultModelRef.input ?? ["text"]),
      timestamp,
      timestamp,
    );
    sqlite.prepare(`
      INSERT INTO agents
        (id, owner_user_id, shared, name, description, working_dir_mode, working_dir, default_working_dir,
         mounts, system_prompt, prompt_templates, permissions, default_model_ref_id, default_thinking_level,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      defaultAgent.id,
      defaultAgent.ownerUserId,
      Number(defaultAgent.shared),
      defaultAgent.name,
      defaultAgent.description,
      defaultAgent.workingDirMode,
      defaultAgent.workingDir,
      defaultAgent.defaultWorkingDir ?? null,
      JSON.stringify(defaultAgent.mounts),
      defaultAgent.systemPrompt,
      JSON.stringify(defaultAgent.promptTemplates),
      JSON.stringify(defaultAgent.permissions),
      defaultAgent.defaultModelRefId,
      defaultAgent.defaultThinkingLevel,
      timestamp,
      timestamp,
    );
    sqlite.prepare(`
      INSERT INTO sessions
        (id, title, user_id, agent_id, model_ref_id, thinking_level, revision, forked_from, pinned_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      defaultSession.id,
      defaultSession.title,
      defaultSession.userId,
      defaultSession.agentId,
      defaultSession.modelRefId,
      defaultSession.thinkingLevel,
      defaultSession.revision,
      timestamp,
      timestamp,
    );
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}
