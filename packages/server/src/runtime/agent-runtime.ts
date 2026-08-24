import {
  AgentHarness,
  formatSkillsForSystemPrompt,
  type AgentHarnessEvent,
  type ExecutionToolContext,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { agents, modelRefs, providerConfigs, sessions, users } from "../db/schema.ts";
import { serializeModelRef } from "../serializers.ts";
import { closePiSession, openPiSession } from "../services/pi-session-storage.ts";
import { resolveModelContext } from "../services/model-context.ts";

import { type PromptInput, type Session } from "@carmel-agent/shared";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgentError, resolveServerModelRef } from "./model.ts";
import { loadAgentResources, resolveAgentWorkingDirPath } from "./resources.ts";
import { projectRunEvent } from "./run-events.ts";
import {
  createActiveAgentRun,
  createRunStream,
  emitRunEvent,
  finishAgentRun,
  type ActiveAgentRun,
} from "./run-stream.ts";
import { generateSessionTitle, shouldGenerateSessionTitle } from "./session-title.ts";
import { createServerExecution } from "./tools.ts";
import { dispatchPrompt } from "../effectors/dispatch-prompt.ts";
import { createPi083AgentDriver, createPi083PromptDispatcher, type Pi083Harness } from "../effectors/pi-0-83/agent-driver.ts";
import { createPi083SessionLog } from "../effectors/pi-0-83/session-log.ts";
import { describeContextPressure, type CompactionOutcome } from "../effectors/compaction-policy.ts";
import { errorMessage } from "../errors.ts";

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

type PiSession = Awaited<ReturnType<typeof openPiSession>>;
type RunHarness = AgentHarness<ExecutionToolContext>;
type ServerExecution = ReturnType<typeof createServerExecution>;

export type AgentRunInput = {
  agent: AgentRecord;
  session: SessionRecord;
  modelRef: ModelRefRecord;
  providerConfig?: ProviderConfigRecord;
  modelRuntime: ModelRuntime;
  thinkingLevel: Session["thinkingLevel"];
  promptInput?: PromptInput;
};

/** Everything the run body and its finalization share, fixed at run startup. */
type AgentRun = AgentRunInput & {
  run: ActiveAgentRun;
  abort: HarnessAbortGate;
  model: Model<Api>;
};

export function createAgentRunResponse(input: AgentRunInput) {
  const abort = new HarnessAbortGate();
  const run = createActiveAgentRun({
    runId: randomId(),
    userId: input.session.userId,
    sessionId: input.session.id,
    abort: () => abort.request(),
  });
  const model = resolveServerModelRef(serializeModelRef(input.modelRef), input.providerConfig, input.modelRuntime);

  queueMicrotask(() => void startAgentRun({ ...input, run, abort, model }));
  return createRunStream(run, new TextEncoder());
}

/**
 * Drive one agent turn to completion. Failures are reported to observers rather
 * than thrown: this runs detached from the HTTP response, so `finalizeRun` in
 * the `finally` is the only thing that can release the run and its resources.
 */
async function startAgentRun(context: AgentRun) {
  const { run, abort, agent, session, model, thinkingLevel, promptInput } = context;
  if (run.started) return;
  run.started = true;

  const retry = new RetryBranch();
  let piSession: PiSession | undefined;
  let execution: ServerExecution | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    piSession = await openPiSession(session.id);
    execution = createServerExecution(agent);
    const { harness, activeToolNames } = await openRunHarness({ ...context, piSession, execution });
    abort.attach(harness);
    unsubscribe = harness.subscribe((event: AgentHarnessEvent) => {
      retry.observe(event);
      const projected = projectRunEvent(event);
      if (projected) emitRunEvent(run, projected);
    });

    // Abort can land at any moment; check wherever the run can still stop without
    // leaving the session branch half-rewound.
    if (abort.requested) {
      await harness.abort();
      return;
    }

    const prepared = await prepareAgentRunPrompt(piSession, promptInput);
    retry.arm(prepared.retryOriginalLeafId);
    await recordRunConfiguration(piSession, model, thinkingLevel, activeToolNames);
    if (abort.requested) {
      await retry.restore(piSession);
      await harness.abort();
      return;
    }

    // Pre-flight: compaction here is what keeps an over-budget session from
    // spending a whole turn to earn a provider context-length rejection.
    await relieveContextPressure(context, harness, piSession);
    if (abort.requested) {
      await retry.restore(piSession);
      await harness.abort();
      return;
    }

    await runHarnessPrompt(harness, prepared.promptInput.text, prepared.promptInput.images);
    if (retry.isAbandoned) throw new Error("Retry completed without persisting the user message.");
    await relieveContextPressure(context, harness, piSession);
  } catch (error) {
    await reportRunFailure(context, { piSession, retry, error });
  } finally {
    await finalizeRun(context, { piSession, execution, unsubscribe });
  }
}

/**
 * Coordinates an abort that can arrive before, during, or after the harness
 * exists. The HTTP abort path calls `request()` from outside the run body, so
 * the flag and the harness handle have to live behind one object rather than as
 * two variables the run body and the abort callback both reach into.
 */
export class HarnessAbortGate {
  #requested = false;
  #harness?: Pick<RunHarness, "abort">;

  get requested() {
    return this.#requested;
  }

  request() {
    this.#requested = true;
    void this.#harness?.abort();
  }

  attach(harness: Pick<RunHarness, "abort">) {
    this.#harness = harness;
  }

  release() {
    this.#harness = undefined;
  }
}

/**
 * A retry rewinds the branch to the parent of the user message before re-sending
 * it, so until the replacement message is persisted the original branch is the
 * only copy. Tracks whether that replacement landed, and restores the original
 * leaf when it did not.
 */
export class RetryBranch {
  #originalLeafId?: string;
  #messagePersisted = false;

  /** `leafId` is undefined for an ordinary prompt, which arms nothing. */
  arm(leafId?: string) {
    this.#originalLeafId = leafId;
  }

  observe(event: AgentHarnessEvent) {
    if (this.#originalLeafId && event.type === "message_end" && event.message.role === "user") {
      this.#messagePersisted = true;
    }
  }

  /** Armed, but the replacement user message was never written. */
  get isAbandoned() {
    return this.#originalLeafId !== undefined && !this.#messagePersisted;
  }

  async restore(piSession: PiSession) {
    if (this.#originalLeafId === undefined) return;
    await piSession.moveTo(this.#originalLeafId);
  }
}

async function openRunHarness(
  context: AgentRun & { piSession: PiSession; execution: ServerExecution },
): Promise<{ harness: RunHarness; activeToolNames: string[] }> {
  const { agent, piSession, execution, model, modelRuntime, thinkingLevel } = context;
  const resources = await loadAgentResources(agent, execution.env);
  const tools = execution.tools;
  const activeToolNames = tools.map((tool) => tool.name);
  const harness = new AgentHarness<ExecutionToolContext>({
    session: piSession,
    models: modelRuntime,
    model,
    thinkingLevel,
    systemPrompt: buildHarnessSystemPrompt({
      base: agent.systemPrompt.trim() || "You are a helpful assistant.",
      cwd: resolveAgentWorkingDirPath(agent),
      skills: resources.skills,
      contextFiles: resources.contextFiles,
      includeSkills: activeToolNames.includes("read"),
    }),
    resources: {
      skills: resources.skills,
      promptTemplates: [
        ...resources.promptTemplates,
        ...agent.promptTemplates.map((template) => ({ name: template.name, content: template.body })),
      ],
    },
    tools,
    toolContext: execution.toolContext,
    activeToolNames,
    streamOptions: { maxRetries: 2, maxRetryDelayMs: 60_000 },
    // Distinct from `streamOptions`, which only covers turn streaming. Without
    // this, a transient provider error during summarization ended compaction for
    // the turn -- on the one call the session most needs to succeed.
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
  });
  return { harness, activeToolNames };
}

/** Restore an abandoned retry branch, then persist and emit the failure. */
async function reportRunFailure(
  context: AgentRun,
  state: { piSession?: PiSession; retry: RetryBranch; error: unknown },
) {
  const { piSession, retry, error } = state;
  if (piSession && retry.isAbandoned) {
    try {
      await retry.restore(piSession);
    } catch (restoreError) {
      console.warn("Retry branch restoration failed:", errorMessage(restoreError));
    }
  }

  const errorEvent = createAgentError(error, context.model);
  try {
    if (piSession) {
      for (const message of errorEvent.messages) await piSession.appendMessage(message);
    }
  } catch (persistenceError) {
    console.warn("Session error persistence failed:", errorMessage(persistenceError));
  }
  // The failure messages were just persisted, so observers pick them up from the
  // session refresh that follows `run_finished`; the event itself only has to
  // stop the streaming indicator.
  emitRunEvent(context.run, { type: "agent_end" });
}

/**
 * Release the run, in this order: read the final transcript, close the Pi
 * session, commit session state and title, detach the observer, release the
 * execution environment, and only then publish `run_finished`. Every step is
 * best-effort, because a failure in any of them must not strand the run without
 * its terminal event or leave it registered as active.
 */
async function finalizeRun(
  context: AgentRun,
  state: { piSession?: PiSession; execution?: ServerExecution; unsubscribe?: () => void },
) {
  const { run, abort, session, modelRef, model, modelRuntime, thinkingLevel } = context;
  const { piSession, execution, unsubscribe } = state;

  let finalMessages: AgentMessage[] = [];
  if (piSession) {
    try {
      finalMessages = (await piSession.getBranch()).flatMap((entry) =>
        entry.type === "message" ? [entry.message] : [],
      );
    } catch (error) {
      console.warn("Final transcript read failed:", errorMessage(error));
    }
    try {
      await closePiSession(piSession);
    } catch (error) {
      console.warn("Pi session cleanup failed:", errorMessage(error));
    }
  }

  try {
    await persistSessionRun(session, {
      messages: finalMessages,
      modelRefId: modelRef.id,
      thinkingLevel,
      model,
      modelRuntime,
    });
  } catch (error) {
    console.warn("Session persistence failed:", errorMessage(error));
  }

  unsubscribe?.();
  try {
    await execution?.env.cleanup();
  } catch (error) {
    console.warn("Execution environment cleanup failed:", errorMessage(error));
  } finally {
    abort.release();
    // Sequenced terminal authority for observers: it follows every persistence
    // and title finalization attempt, and the execution cleanup.
    emitRunEvent(run, { type: "run_finished" });
    finishAgentRun(run);
  }
}

/**
 * A run without prompt input is a retry/edit-and-resend. The active branch
 * already ends in the user message, so rewind to its parent and send that same
 * content through AgentHarness.prompt(). This preserves the abandoned branch
 * without inserting the empty user message that prompt("") would create.
 */
export async function prepareAgentRunPrompt(
  piSession: Awaited<ReturnType<typeof openPiSession>>,
  promptInput?: PromptInput,
): Promise<{ promptInput: PromptInput; retryOriginalLeafId?: string }> {
  if (promptInput) return { promptInput };

  const branch = await piSession.getBranch();
  const lastEntry = branch.at(-1);
  if (lastEntry?.type !== "message" || lastEntry.message.role !== "user") {
    throw new Error("Cannot retry: the active session branch must end in a user message.");
  }

  const retryPromptInput = promptInputFromUserMessage(lastEntry.message);
  await piSession.moveTo(lastEntry.parentId);
  return {
    promptInput: retryPromptInput,
    retryOriginalLeafId: lastEntry.id,
  };
}

/**
 * Dispatch composer text to the agent loop.
 *
 * The rule -- which slash commands exist and which wins when a name is
 * ambiguous -- now lives in `effectors/dispatch-prompt.ts` with no Pi imports,
 * and the Pi-shaped parts of it (invocation formatting, argument parsing, the
 * fact that a named invocation cannot carry an attachment) live in the 0.83
 * adapter. This is the seam: everything below it is what the harness rewrite
 * gets to change.
 */
export async function runHarnessPrompt(
  harness: Pi083Harness,
  text: string,
  images?: PromptInput["images"],
) {
  return dispatchPrompt(createPi083PromptDispatcher(harness), text, images);
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
  piSession: Awaited<ReturnType<typeof openPiSession>>,
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

/**
 * Bring the session back under its context budget and report what happened.
 *
 * Runs twice per turn. Before the prompt, because a session can arrive over
 * budget without having grown -- moving it onto a smaller-window model is
 * enough, and Carmel allows that per session -- and after, because that is when
 * it has just grown. Everything except a clean result reaches the user: the
 * failure mode this replaces was a `console.warn` on a session that kept
 * accepting turns while heading for a wall nobody had been told about.
 */
async function relieveContextPressure(context: AgentRun, harness: RunHarness, piSession: PiSession) {
  const driver = createPi083AgentDriver({
    harness,
    log: createPi083SessionLog(piSession),
    model: context.model,
  });

  let outcome: CompactionOutcome;
  try {
    outcome = await driver.relieveContextPressure();
  } catch (error) {
    // The driver reports rather than throws, so reaching here means the
    // measurement itself broke. Never let that end the run.
    console.warn("Context pressure check failed:", errorMessage(error));
    return;
  }

  const notice = describeContextPressure(outcome);
  if (!notice) return;
  console.warn(`Context pressure (${outcome.status}) on session ${context.session.id}: ${notice.message}`);
  emitRunEvent(context.run, { type: "context_pressure", level: notice.level, message: notice.message });
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
      errorMessage(error),
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
