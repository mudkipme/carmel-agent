import {
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  shouldCompact,
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  parseCommandArgs,
  formatSkillsForSystemPrompt,
  type AgentEvent,
  type AgentHarnessEvent,
  type AgentHarnessTool,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { agents, modelRefs, providerConfigs, providerKeys, sessions, users } from "../db/schema.ts";
import { revealSecret } from "../security.ts";
import { serializeModelRef } from "../serializers.ts";
import { ensureOptionalProviderAuth, hasProviderAuth } from "../services/provider-auth.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { readSessionMessages } from "../services/session-store.ts";
import { type PromptInput, type Session } from "@carmel-agent/shared";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createProviderConfigCredentialStore } from "./auth-storage.ts";
import { createAgentError, resolveServerModelRef } from "./model.ts";
import { createCarmelModelRuntime } from "./model-runtime.ts";
import { createAgentResourceLoader, resolveAgentWorkingDirPath } from "./resources.ts";
import {
  createActiveAgentRun,
  createRunStream,
  emitRunEvent,
  finishAgentRun,
  type RunEvent,
} from "./run-stream.ts";
import { generateSessionTitle, shouldGenerateSessionTitle } from "./session-title.ts";
import { createServerToolDefinitions } from "./tools.ts";

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
  let activeHarness: AgentHarness | undefined;
  let abortRequested = false;
  const abortRun = () => {
    abortRequested = true;
    void activeHarness?.abort();
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

    const piSession = openPiSession(session.id);
    let harness: AgentHarness | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      const resourceLoader = await createAgentResourceLoader(agent);
      const skills = await Promise.all(
        resourceLoader.getSkills().skills.map(async (skill) => ({
          name: skill.name,
          description: skill.description,
          content: stripSkillFrontmatter(await readFile(skill.filePath, "utf8")),
          filePath: skill.filePath,
          disableModelInvocation: skill.disableModelInvocation,
        })),
      );
      const promptTemplates = [
        ...resourceLoader.getPrompts().prompts.map((template) => ({
          name: template.name,
          description: template.description,
          content: template.content,
        })),
        ...agent.promptTemplates.map((template) => ({ name: template.name, content: template.body })),
      ];
      const tools = createServerToolDefinitions(agent) as unknown as AgentHarnessTool<undefined>[];
      const activeToolNames = tools.map((tool) => tool.name);
      const systemPrompt = buildHarnessSystemPrompt({
        base: resourceLoader.getSystemPrompt()?.trim() || "You are a helpful assistant.",
        cwd: resolveAgentWorkingDirPath(agent),
        skills,
        contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
        includeSkills: activeToolNames.includes("read"),
      });
      await recordRunConfiguration(piSession, model, thinkingLevel, activeToolNames);

      harness = new AgentHarness({
        session: piSession,
        models: modelRuntime,
        model,
        thinkingLevel,
        systemPrompt,
        resources: {
          skills,
          promptTemplates,
        },
        tools,
        activeToolNames,
        streamOptions: { maxRetries: 2, maxRetryDelayMs: 60_000 },
      });
      activeHarness = harness;
      unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
        emit(event as RunEvent);
      });

      if (abortRequested) {
        await harness.abort();
        return;
      }
      await runHarnessPrompt(harness, promptInput?.text ?? "", promptInput?.images);
      await compactIfNeeded(harness, piSession, model);
    } catch (error) {
      const errorEvent = createAgentError(error, model);
      try {
        for (const message of errorEvent.messages) await piSession.appendMessage(message);
      } catch (persistenceError) {
        console.warn(
          "Session error persistence failed:",
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
        );
      }
      emit(errorEvent as AgentEvent);
    } finally {
      const finalMessages = readSessionMessages(session.id);
      try {
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
      activeHarness = undefined;
      finishAgentRun(run);
    }
  };

  queueMicrotask(() => void startRun());
  return createRunStream(run, encoder);
}

export async function runHarnessPrompt(
  harness: AgentHarness,
  text: string,
  images?: PromptInput["images"],
) {
  const resources = harness.getResources();
  const skillMatch = text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
  if (skillMatch) {
    const skill = resources.skills?.find((candidate) => candidate.name === skillMatch[1]);
    if (skill) {
      const additionalInstructions = skillMatch[2]?.trim() || undefined;
      if (images?.length) {
        return harness.prompt(formatSkillInvocation(skill, additionalInstructions), { images });
      }
      return harness.skill(skill.name, additionalInstructions);
    }
  }

  const templateMatch = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (templateMatch) {
    const template = resources.promptTemplates?.find((candidate) => candidate.name === templateMatch[1]);
    if (template) {
      const args = parseCommandArgs(templateMatch[2] ?? "");
      if (images?.length) {
        return harness.prompt(formatPromptTemplateInvocation(template, args), { images });
      }
      return harness.promptFromTemplate(template.name, args);
    }
  }
  return harness.prompt(text, { images });
}

async function recordRunConfiguration(
  piSession: ReturnType<typeof openPiSession>,
  model: Model<Api>,
  thinkingLevel: Session["thinkingLevel"],
  activeToolNames: string[],
) {
  const context = await piSession.buildContext();
  if (context.model?.provider !== model.provider || context.model.modelId !== model.id) {
    await piSession.appendModelChange(model.provider, model.id);
  }
  if (context.thinkingLevel !== thinkingLevel) await piSession.appendThinkingLevelChange(thinkingLevel);
  if (!sameStrings(context.activeToolNames, activeToolNames)) {
    await piSession.appendActiveToolsChange(activeToolNames);
  }
}

async function compactIfNeeded(
  harness: AgentHarness,
  piSession: ReturnType<typeof openPiSession>,
  model: Model<Api>,
) {
  const context = await piSession.buildContext();
  const contextTokens = estimateContextTokens(context.messages).tokens;
  if (!shouldCompact(contextTokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;
  try {
    await harness.compact();
  } catch (error) {
    console.warn("Session compaction failed:", error instanceof Error ? error.message : String(error));
  }
}

function sameStrings(left: string[] | null, right: string[]) {
  return Boolean(left && left.length === right.length && left.every((value, index) => value === right[index]));
}

function buildHarnessSystemPrompt(options: {
  base: string;
  cwd: string;
  skills: Parameters<typeof formatSkillsForSystemPrompt>[0];
  contextFiles: Array<{ path: string; content: string }>;
  includeSkills: boolean;
}) {
  let prompt = options.base;
  if (options.contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
    for (const file of options.contextFiles) {
      prompt += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }
  if (options.includeSkills && options.skills.length > 0) {
    prompt += `\n\n${formatSkillsForSystemPrompt(options.skills)}`;
  }
  return `${prompt}\nCurrent working directory: ${options.cwd.replaceAll("\\", "/")}`;
}

function stripSkillFrontmatter(content: string) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
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
