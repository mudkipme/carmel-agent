import { type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AuthStorage,
  createAgentSession,
  type CreateAgentSessionOptions,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { agents, modelRefs, providerConfigs, providerKeys, sessions, users } from "../db/schema.ts";
import { revealSecret } from "../security.ts";
import { serializeModelRef } from "../serializers.ts";
import { createProviderConfigAuthStorage } from "./auth-storage.ts";
import { cleanupRunClientTools, createClientToolDefinitions } from "./client-tools.ts";
import { createAgentError, resolveServerModelRef } from "./model.ts";
import { createAgentResourceLoader, resolveAgentWorkingDirPath, serverAgentDir } from "./resources.ts";
import {
  createActiveAgentRun,
  createRunStream,
  emitRunEvent,
  finishAgentRun,
  type RunEvent,
} from "./run-stream.ts";
import { generateSessionTitle, shouldGenerateSessionTitle } from "./session-title.ts";
import { createServerToolDefinitions } from "./tools.ts";
import { OLLAMA_PROVIDER, type PromptInput, type Session } from "@carmel-agent/shared";
import type { Api, Model } from "@earendil-works/pi-ai";

type AgentRecord = typeof agents.$inferSelect;
type ModelRefRecord = typeof modelRefs.$inferSelect;
type ProviderConfigRecord = typeof providerConfigs.$inferSelect;
type SessionRecord = typeof sessions.$inferSelect;
export { abortAgentRun, createAgentRunEventStream, getActiveAgentRunForSession } from "./run-stream.ts";

export function normalizePromptInput(input?: PromptInput) {
  if (!input) return undefined;
  const text = typeof input.text === "string" ? input.text : "";
  const images = Array.isArray(input.images)
    ? input.images.filter(
        (image) =>
          image?.type === "image" &&
          typeof image.data === "string" &&
          typeof image.mimeType === "string",
      )
    : undefined;
  if (!text.trim() && (!images || images.length === 0)) {
    throw new Error("Prompt input text or image content is required.");
  }
  return {
    text,
    images: images && images.length > 0 ? images : undefined,
  } satisfies PromptInput;
}

export function createAgentRunResponse({
  agent,
  session,
  modelRef,
  providerConfig,
  authStorage,
  thinkingLevel,
  promptInput,
}: {
  agent: AgentRecord;
  session: SessionRecord;
  modelRef: ModelRefRecord;
  providerConfig?: ProviderConfigRecord;
  authStorage: AuthStorage;
  thinkingLevel: Session["thinkingLevel"];
  promptInput?: PromptInput;
}) {
  const runId = randomId();
  const model = resolveServerModelRef(
    { ...serializeModelRef(modelRef), customHeaders: modelRef.customHeaders ?? undefined },
    providerConfig,
  );
  const encoder = new TextEncoder();
  let activeSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let abortRequested = false;
  const abortRun = () => {
    abortRequested = true;
    void activeSession?.abort();
  };
  const run = createActiveAgentRun({
    runId,
    userId: session.userId,
    sessionId: session.id,
    abort: abortRun,
  });

  const emit = (event: RunEvent) => emitRunEvent(run, event);
  const startRun = async () => {
    if (run.started) return;
    run.started = true;

    let sdkSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let unsubscribe: (() => void) | undefined;
    let messagesToPersist: AgentMessage[] | undefined;
    try {
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      const resourceLoader = await createAgentResourceLoader(agent);
      const cwd = resolveAgentWorkingDirPath(agent);
      const customTools = [
        ...createServerToolDefinitions(agent),
        ...createClientToolDefinitions(agent, {
          runId,
          userId: session.userId,
          sessionId: session.id,
          emit,
        }),
      ];
      const allowedTools = customTools.map((tool) => tool.name);
      const { session: piSession } = await createAgentSession({
        cwd,
        agentDir: serverAgentDir,
        authStorage,
        modelRegistry,
        model,
        thinkingLevel,
        resourceLoader,
        customTools: customTools as unknown as CreateAgentSessionOptions["customTools"],
        tools: allowedTools,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 2, provider: { maxRetryDelayMs: 60000 } },
        }),
      });
      sdkSession = piSession;
      activeSession = sdkSession;
      sdkSession.agent.state.messages = session.messages;
      if (abortRequested) {
        await sdkSession.abort();
        return;
      }
      unsubscribe = sdkSession.subscribe((event) => {
        emit(event);
      });

      if (promptInput) {
        await sdkSession.prompt(promptInput.text, {
          images: promptInput.images,
          expandPromptTemplates: true,
        });
      } else {
        await sdkSession.agent.prompt([]);
      }
    } catch (error) {
      const errorEvent = createAgentError(error, model);
      messagesToPersist = [...(sdkSession?.agent.state.messages ?? session.messages), ...errorEvent.messages];
      emit(errorEvent as AgentEvent);
    } finally {
      cleanupRunClientTools(runId);
      try {
        await persistSessionRun(session, {
          messages: messagesToPersist ?? sdkSession?.agent.state.messages ?? session.messages,
          modelRefId: modelRef.id,
          thinkingLevel,
          model,
          authStorage,
        });
      } catch (error) {
        console.warn("Session persistence failed:", error instanceof Error ? error.message : String(error));
      }
      unsubscribe?.();
      sdkSession?.dispose();
      activeSession = undefined;
      finishAgentRun(run);
    }
  };

  queueMicrotask(() => void startRun());
  return createRunStream(run, encoder);
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

async function persistSessionRun(
  session: SessionRecord,
  patch: {
    messages: AgentMessage[];
    modelRefId: string;
    thinkingLevel: Session["thinkingLevel"];
    model: ReturnType<typeof resolveServerModelRef>;
    authStorage: AuthStorage;
  },
) {
  const timestamp = now();
  db.update(sessions)
    .set({
      messages: patch.messages,
      modelRefId: patch.modelRefId,
      thinkingLevel: patch.thinkingLevel,
      updatedAt: timestamp,
    })
    .where(eq(sessions.id, session.id))
    .run();

  if (!shouldGenerateSessionTitle(session.title, patch.messages)) return;

  try {
    const titleModelContext = resolveTitleModelContext(session.userId, {
      model: patch.model,
      authStorage: patch.authStorage,
    });
    const modelRegistry = ModelRegistry.inMemory(titleModelContext.authStorage);
    const auth = await modelRegistry.getApiKeyAndHeaders(titleModelContext.model);
    if (!auth.ok || !auth.apiKey) return;
    const title = await generateSessionTitle({
      model: titleModelContext.model,
      apiKey: auth.apiKey,
      headers: auth.headers,
      messages: patch.messages,
    });
    if (!title) return;
    db.update(sessions)
      .set({ title, updatedAt: now() })
      .where(eq(sessions.id, session.id))
      .run();
  } catch (error) {
    console.warn(
      "Session title generation failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function resolveTitleModelContext(
  userId: string,
  fallback: { model: Model<Api>; authStorage: AuthStorage },
) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  const fastTaskModelRefId = user?.fastTaskModelRefId;
  if (!fastTaskModelRefId) return fallback;

  const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, fastTaskModelRefId)).get();
  if (!modelRef || !canUserUseTitleModel(userId, modelRef)) return fallback;

  const providerConfig = modelRef.providerConfigId
    ? db.select().from(providerConfigs).where(eq(providerConfigs.id, modelRef.providerConfigId)).get()
    : undefined;
  const authStorage = providerConfig ? createProviderConfigAuthStorage(providerConfig, modelRef.provider) : AuthStorage.inMemory();
  if (!providerConfig) {
    const providerKey = db
      .select()
      .from(providerKeys)
      .where(eq(providerKeys.userId, userId))
      .all()
      .find((item) => item.provider === modelRef.provider);
    if (providerKey?.apiKey) authStorage.setRuntimeApiKey(modelRef.provider, revealSecret(providerKey.apiKey) ?? "");
  }
  ensureOptionalProviderAuth(authStorage, modelRef.provider);
  if (!hasProviderAuth(authStorage, modelRef.provider)) return fallback;

  return {
    model: resolveServerModelRef(
      { ...serializeModelRef(modelRef), customHeaders: modelRef.customHeaders ?? undefined },
      providerConfig,
    ),
    authStorage,
  };
}

function hasProviderAuth(authStorage: AuthStorage, provider: string) {
  return provider === OLLAMA_PROVIDER || authStorage.hasAuth(provider);
}

function ensureOptionalProviderAuth(authStorage: AuthStorage, provider: string) {
  if (provider === OLLAMA_PROVIDER && !authStorage.hasAuth(provider)) {
    authStorage.setRuntimeApiKey(provider, "ollama");
  }
}

function canUserUseTitleModel(userId: string, modelRef: ModelRefRecord) {
  if (modelRef.ownerUserId === userId || modelRef.shared || !modelRef.providerConfigId) return true;
  return Boolean(
    db
      .select()
      .from(providerConfigs)
      .where(eq(providerConfigs.id, modelRef.providerConfigId))
      .get()?.userId === userId,
  );
}
