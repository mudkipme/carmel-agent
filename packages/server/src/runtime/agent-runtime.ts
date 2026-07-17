import { type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { agents, modelRefs, providerConfigs, providerKeys, sessions, users } from "../db/schema.ts";
import { revealSecret } from "../security.ts";
import { serializeModelRef } from "../serializers.ts";
import { createProviderConfigCredentialStore } from "./auth-storage.ts";
import { createAgentError, resolveServerModelRef } from "./model.ts";
import { createCarmelModelRuntime } from "./model-runtime.ts";
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
import { ensureOptionalProviderAuth, hasProviderAuth } from "../services/provider-auth.ts";
import { appendSessionMessages, readSessionMessages } from "../services/session-store.ts";
import { type PromptInput, type Session } from "@carmel-agent/shared";
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
  modelRuntime,
  thinkingLevel,
  promptInput,
}: {
  agent: AgentRecord;
  session: SessionRecord;
  modelRef: ModelRefRecord;
  providerConfig?: ProviderConfigRecord;
  modelRuntime: ModelRuntime;
  thinkingLevel: Session["thinkingLevel"];
  promptInput?: PromptInput;
}) {
  const runId = randomId();
  const model = resolveServerModelRef(serializeModelRef(modelRef), providerConfig);
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
    let initialMessages: AgentMessage[] = [];
    let persistedCount = 0;
    try {
      // Load the transcript first so a setup failure still has the real history
      // for the error-message append below (and never wipes it).
      initialMessages = readSessionMessages(session.id);
      persistedCount = initialMessages.length;
      const resourceLoader = await createAgentResourceLoader(agent);
      const cwd = resolveAgentWorkingDirPath(agent);
      const customTools = [...createServerToolDefinitions(agent)];
      const allowedTools = customTools.map((tool) => tool.name);
      const { session: piSession } = await createAgentSession({
        cwd,
        agentDir: serverAgentDir,
        modelRuntime,
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
      sdkSession.agent.state.messages = initialMessages;
      if (abortRequested) {
        await sdkSession.abort();
        return;
      }
      unsubscribe = sdkSession.subscribe((event) => {
        emit(event);
        // Append after every completed message so a crash or hard kill loses at
        // most the in-flight streaming message, not the whole turn. agent.js
        // pushes the message onto state before notifying listeners, so the list
        // is already complete here. Only new messages are written (O(new), not
        // O(history)); the run-end reconcile below is authoritative.
        if (event.type === "message_end") {
          try {
            persistedCount = appendSessionMessages(session.id, piSession.agent.state.messages, persistedCount);
          } catch (error) {
            console.warn(
              "Incremental session persistence failed:",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
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
      messagesToPersist = [...(sdkSession?.agent.state.messages ?? initialMessages), ...errorEvent.messages];
      emit(errorEvent as AgentEvent);
    } finally {
      const finalMessages = messagesToPersist ?? sdkSession?.agent.state.messages ?? initialMessages;
      try {
        // The transcript is append-only during a run, so incremental appends
        // already wrote everything; this flushes only the tail not yet persisted
        // (e.g. a synthesized error message), not the whole history.
        appendSessionMessages(session.id, finalMessages, persistedCount);
        await persistSessionRun(session, {
          messages: finalMessages,
          modelRefId: modelRef.id,
          thinkingLevel,
          model,
          modelRuntime,
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
    modelRuntime: ModelRuntime;
  },
) {
  const timestamp = now();
  // Messages are persisted incrementally during the run; here we only patch the
  // session record and (below) generate a title.
  db.update(sessions)
    .set({
      modelRefId: patch.modelRefId,
      thinkingLevel: patch.thinkingLevel,
      updatedAt: timestamp,
    })
    .where(eq(sessions.id, session.id))
    .run();

  if (!shouldGenerateSessionTitle(session.title, patch.messages)) return;

  try {
    const titleModelContext = await resolveTitleModelContext(session.userId, {
      model: patch.model,
      modelRuntime: patch.modelRuntime,
    });
    const auth = await titleModelContext.modelRuntime.getAuth(titleModelContext.model);
    if (!auth?.auth.apiKey) return;
    const title = await generateSessionTitle({
      model: titleModelContext.model,
      apiKey: auth.auth.apiKey,
      headers: auth.auth.headers,
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

async function resolveTitleModelContext(
  userId: string,
  fallback: { model: Model<Api>; modelRuntime: ModelRuntime },
) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  const fastTaskModelRefId = user?.fastTaskModelRefId;
  if (!fastTaskModelRefId) return fallback;

  const modelRef = db.select().from(modelRefs).where(eq(modelRefs.id, fastTaskModelRefId)).get();
  if (!modelRef || !canUserUseTitleModel(userId, modelRef)) return fallback;

  const providerConfig = modelRef.providerConfigId
    ? db.select().from(providerConfigs).where(eq(providerConfigs.id, modelRef.providerConfigId)).get()
    : undefined;
  const modelRuntime = await createCarmelModelRuntime(
    providerConfig ? createProviderConfigCredentialStore(providerConfig, modelRef.provider) : undefined,
  );
  if (!providerConfig) {
    const providerKey = db
      .select()
      .from(providerKeys)
      .where(eq(providerKeys.userId, userId))
      .all()
      .find((item) => item.provider === modelRef.provider);
    if (providerKey?.apiKey) {
      await modelRuntime.setRuntimeApiKey(modelRef.provider, revealSecret(providerKey.apiKey) ?? "");
    }
  }
  await ensureOptionalProviderAuth(modelRuntime, modelRef.provider);
  if (!(await hasProviderAuth(modelRuntime, modelRef.provider))) return fallback;

  return {
    model: resolveServerModelRef(serializeModelRef(modelRef), providerConfig),
    modelRuntime,
  };
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
