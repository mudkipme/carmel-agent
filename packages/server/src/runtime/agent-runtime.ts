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
import { db } from "../db";
import { now } from "../db/seed";
import { agents, modelRefs, providerConfigs, sessions } from "../db/schema";
import { serializeModelRef } from "../serializers";
import { createAgentError, resolveServerModelRef } from "./model";
import { createAgentResourceLoader, serverAgentDir } from "./resources";
import { generateSessionTitle, shouldGenerateSessionTitle } from "./session-title";
import { createServerToolDefinitions } from "./tools";
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
  apiKey,
  thinkingLevel,
  promptInput,
}: {
  agent: AgentRecord;
  session: SessionRecord;
  modelRef: ModelRefRecord;
  providerConfig?: ProviderConfigRecord;
  apiKey: string;
  thinkingLevel: Session["thinkingLevel"];
  promptInput?: PromptInput;
}) {
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
        try {
          const authStorage = AuthStorage.inMemory();
          authStorage.setRuntimeApiKey(model.provider, apiKey);
          const modelRegistry = ModelRegistry.inMemory(authStorage);
          const resourceLoader = await createAgentResourceLoader(agent);
          const customTools = createServerToolDefinitions(agent);
          const allowedTools = customTools.map((tool) => tool.name);
          const { session: piSession } = await createAgentSession({
            cwd: agent.workingDir,
            agentDir: serverAgentDir,
            authStorage,
            modelRegistry,
            model,
            thinkingLevel,
            resourceLoader,
            customTools: customTools as unknown as CreateAgentSessionOptions["customTools"],
            tools: allowedTools,
            sessionManager: SessionManager.inMemory(agent.workingDir),
            settingsManager: SettingsManager.inMemory({
              compaction: { enabled: false },
              retry: { enabled: true, maxRetries: 2, provider: { maxRetryDelayMs: 60000 } },
            }),
          });
          sdkSession = piSession;
          activeSession = sdkSession;
          sdkSession.agent.state.messages = session.messages;
          unsubscribe = sdkSession.subscribe((event) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
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
          controller.enqueue(encoder.encode(`${JSON.stringify(errorEvent)}\n`));
        } finally {
          await persistSessionRun(session, {
            messages: messagesToPersist ?? sdkSession?.agent.state.messages ?? session.messages,
            modelRefId: modelRef.id,
            thinkingLevel,
            model,
            apiKey,
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

function persistSessionRun(
  session: SessionRecord,
  patch: {
    messages: AgentMessage[];
    modelRefId: string;
    thinkingLevel: Session["thinkingLevel"];
    model: ReturnType<typeof resolveServerModelRef>;
    apiKey: string;
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
  return generateSessionTitle({
    model: patch.model,
    apiKey: patch.apiKey,
    messages: patch.messages,
  })
    .then((title) => {
      if (!title) return;
      db.update(sessions)
        .set({ title, updatedAt: now() })
        .where(eq(sessions.id, session.id))
        .run();
    })
    .catch(() => {
      // Title generation is best-effort and should never fail the completed agent run.
    });
}
