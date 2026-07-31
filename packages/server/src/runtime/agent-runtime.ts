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
  type ExecutionToolContext,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { agents, modelRefs, providerConfigs, sessions, users } from "../db/schema.ts";
import { serializeModelRef } from "../serializers.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { resolveModelContext } from "../services/model-context.ts";
import { readSessionMessages } from "../services/session-store.ts";
import { type PromptInput, type Session } from "@carmel-agent/shared";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgentError, resolveServerModelRef } from "./model.ts";
import { createAgentResourceLoader, resolveAgentWorkingDirPath } from "./resources.ts";
import {
  createActiveAgentRun,
  createRunStream,
  emitRunEvent,
  finishAgentRun,
  type RunEvent,
} from "./run-stream.ts";
import { generateSessionTitle, shouldGenerateSessionTitle } from "./session-title.ts";
import { createServerExecution } from "./tools.ts";

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
  let activeHarness: AgentHarness<ExecutionToolContext> | undefined;
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
    let harness: AgentHarness<ExecutionToolContext> | undefined;
    let execution: ReturnType<typeof createServerExecution> | undefined;
    let unsubscribe: (() => void) | undefined;
    let retryOriginalLeafId: string | undefined;
    let retryMessagePersisted = false;
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
      execution = createServerExecution(agent);
      const tools = execution.tools as unknown as AgentHarnessTool<ExecutionToolContext>[];
      const activeToolNames = tools.map((tool) => tool.name);
      const systemPrompt = buildHarnessSystemPrompt({
        base: resourceLoader.getSystemPrompt()?.trim() || "You are a helpful assistant.",
        cwd: resolveAgentWorkingDirPath(agent),
        skills,
        contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
        includeSkills: activeToolNames.includes("read"),
      });
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
        toolContext: execution.toolContext,
        activeToolNames,
        streamOptions: { maxRetries: 2, maxRetryDelayMs: 60_000 },
      });
      activeHarness = harness;
      unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
        if (retryOriginalLeafId && event.type === "message_end" && event.message.role === "user") {
          retryMessagePersisted = true;
        }
        emit(event as RunEvent);
      });

      if (abortRequested) {
        await harness.abort();
        return;
      }
      const preparedPrompt = await prepareAgentRunPrompt(piSession, promptInput);
      retryOriginalLeafId = preparedPrompt.retryOriginalLeafId;
      await recordRunConfiguration(piSession, model, thinkingLevel, activeToolNames);
      if (abortRequested) {
        if (retryOriginalLeafId) await piSession.getStorage().setLeafId(retryOriginalLeafId);
        await harness.abort();
        return;
      }
      await runHarnessPrompt(harness, preparedPrompt.promptInput.text, preparedPrompt.promptInput.images);
      if (retryOriginalLeafId && !retryMessagePersisted) {
        throw new Error("Retry completed without persisting the user message.");
      }
      await compactIfNeeded(harness, piSession, model);
    } catch (error) {
      if (retryOriginalLeafId && !retryMessagePersisted) {
        try {
          await piSession.getStorage().setLeafId(retryOriginalLeafId);
        } catch (restoreError) {
          console.warn(
            "Retry branch restoration failed:",
            restoreError instanceof Error ? restoreError.message : String(restoreError),
          );
        }
      }
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
      await execution?.env.cleanup();
      activeHarness = undefined;
      finishAgentRun(run);
    }
  };

  queueMicrotask(() => void startRun());
  return createRunStream(run, encoder);
}

/**
 * A run without prompt input is a retry/edit-and-resend. The active branch
 * already ends in the user message, so rewind to its parent and send that same
 * content through AgentHarness.prompt(). This preserves the abandoned branch
 * without inserting the empty user message that prompt("") would create.
 */
export async function prepareAgentRunPrompt(
  piSession: ReturnType<typeof openPiSession>,
  promptInput?: PromptInput,
): Promise<{ promptInput: PromptInput; retryOriginalLeafId?: string }> {
  if (promptInput) return { promptInput };

  const branch = await piSession.getBranch();
  const lastEntry = branch.at(-1);
  if (lastEntry?.type !== "message" || lastEntry.message.role !== "user") {
    throw new Error("Cannot retry: the active session branch must end in a user message.");
  }

  const retryPromptInput = promptInputFromUserMessage(lastEntry.message);
  await piSession.getStorage().setLeafId(lastEntry.parentId);
  return {
    promptInput: retryPromptInput,
    retryOriginalLeafId: lastEntry.id,
  };
}

export async function runHarnessPrompt(
  harness: Pick<AgentHarness, "getResources" | "prompt" | "skill" | "promptFromTemplate">,
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

function promptInputFromUserMessage(message: Extract<AgentMessage, { role: "user" }>): PromptInput {
  if (typeof message.content === "string") {
    if (!message.content.trim()) throw new Error("Cannot retry an empty user message.");
    return { text: message.content };
  }

  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const images = message.content.filter((part) => part.type === "image");
  if (!text.trim() && images.length === 0) throw new Error("Cannot retry an empty user message.");
  return {
    text,
    images: images.length > 0 ? images : undefined,
  };
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
  harness: Pick<AgentHarness, "compact">,
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
  // Messages are persisted incrementally during the run. Commit the session
  // record only if it still has the revision leased at run startup, so a stale
  // run can never overwrite a newer mutation that bypassed the HTTP lease.
  const committedRevision = commitSessionRunState(session.id, session.revision, {
    modelRefId: patch.modelRefId,
    thinkingLevel: patch.thinkingLevel,
    updatedAt: now(),
  });
  if (committedRevision === undefined) {
    console.warn(`Skipped stale agent-run finalization for session ${session.id}.`);
    return;
  }

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
    if (commitSessionRunTitle(session.id, committedRevision, title) === undefined) {
      console.warn(`Skipped stale title update for session ${session.id}.`);
    }
  } catch (error) {
    console.warn(
      "Session title generation failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function commitSessionRunState(
  sessionId: string,
  expectedRevision: number,
  patch: {
    modelRefId: string;
    thinkingLevel: Session["thinkingLevel"];
    updatedAt: number;
  },
) {
  const revision = expectedRevision + 1;
  const result = db
    .update(sessions)
    .set({ ...patch, revision })
    .where(and(eq(sessions.id, sessionId), eq(sessions.revision, expectedRevision)))
    .run();
  return result.changes === 1 ? revision : undefined;
}

export function commitSessionRunTitle(sessionId: string, expectedRevision: number, title: string) {
  const revision = expectedRevision + 1;
  const result = db
    .update(sessions)
    .set({ title, revision, updatedAt: now() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.revision, expectedRevision)))
    .run();
  return result.changes === 1 ? revision : undefined;
}

async function resolveTitleModelContext(
  userId: string,
  fallback: { model: Model<Api>; modelRuntime: ModelRuntime },
) {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  const fastTaskModelRefId = user?.fastTaskModelRefId;
  if (!fastTaskModelRefId) return fallback;

  const result = await resolveModelContext(userId, fastTaskModelRefId, { canUse: canUserUseTitleModel });
  if (!result.ok) return fallback;
  return {
    model: result.value.model,
    modelRuntime: result.value.modelRuntime,
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
