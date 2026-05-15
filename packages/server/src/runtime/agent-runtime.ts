import { type AgentMessage } from "@earendil-works/pi-agent-core";
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
import { agents, modelRefs, providerConfigs, sessions } from "../db/schema.ts";
import { serializeModelRef } from "../serializers.ts";
import { cleanupRunClientTools, createClientToolDefinitions } from "./client-tools.ts";
import { createAgentError, resolveServerModelRef } from "./model.ts";
import { createAgentResourceLoader, resolveAgentWorkingDirPath, serverAgentDir } from "./resources.ts";
import { generateSessionTitle, shouldGenerateSessionTitle } from "./session-title.ts";
import { createServerToolDefinitions } from "./tools.ts";
import type { PromptInput, Session } from "@carmel-agent/shared";

type AgentRecord = typeof agents.$inferSelect;
type ModelRefRecord = typeof modelRefs.$inferSelect;
type ProviderConfigRecord = typeof providerConfigs.$inferSelect;
type SessionRecord = typeof sessions.$inferSelect;

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
  return new Response(
    new ReadableStream({
      async start(controller) {
        let sdkSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        let unsubscribe: (() => void) | undefined;
        let messagesToPersist: AgentMessage[] | undefined;
        const emit = (event: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
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
          emit(errorEvent);
        } finally {
          cleanupRunClientTools(runId);
          await persistSessionRun(session, {
            messages: messagesToPersist ?? sdkSession?.agent.state.messages ?? session.messages,
            modelRefId: modelRef.id,
            thinkingLevel,
            model,
            authStorage,
          });
          unsubscribe?.();
          sdkSession?.dispose();
          activeSession = undefined;
          controller.close();
        }
      },
      cancel() {
        void activeSession?.abort();
      },
    }),
    { headers: { "content-type": "application/x-ndjson; charset=utf-8" } },
  );
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
    const modelRegistry = ModelRegistry.inMemory(patch.authStorage);
    const auth = await modelRegistry.getApiKeyAndHeaders(patch.model);
    if (!auth.ok || !auth.apiKey) return;
    const title = await generateSessionTitle({
      model: patch.model,
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
