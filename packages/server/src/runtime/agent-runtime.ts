import { recordSessionActivity } from "../services/activity.ts";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  DEFAULT_COMPACTION_SETTINGS,
  type AgentHarnessTool,
  formatSkillsForSystemPrompt,
  type AgentLane,
  type Context as PiContext,
  type ExecutionToolContext,
  type HarnessEvent,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { agents, modelRefs, providerConfigs, sessions, users } from "../db/schema.ts";
import { serializeModelRef } from "../serializers.ts";
import { closePiSession, openPiSession, registerPiSessionLane } from "../services/pi-session-storage.ts";
import { resolveModelContext } from "../services/model-context.ts";

import { type AgentRunEvent, type PromptInput, type Session } from "@carmel-agent/shared";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgentError, resolveServerModelRef } from "./model.ts";
import { loadAgentResources, resolveAgentWorkingDirPath } from "./resources.ts";
import { classifyHarnessTurnFailure, projectRunEvent } from "./run-events.ts";
import {
  createActiveAgentRun,
  emitRunEvent,
  finishAgentRun,
  type ActiveAgentRun,
} from "./run-stream.ts";
import { generateSessionTitle, shouldGenerateSessionTitle } from "./session-title.ts";
import { createServerExecution } from "./tools.ts";
import { registerCodemodeResultHook } from "./codemode-tool.ts";
import { dispatchPrompt } from "../effectors/dispatch-prompt.ts";
import {
  createPiPromptDispatcher,
  estimateBranchTokens,
  observeHarnessEvents,
  reconcileLaneConfiguration,
  type PiDispatcherOptions,
} from "../effectors/pi-0-99/agent-driver.ts";
import { createPiSessionLog, PI_MAIN_BRANCH } from "../effectors/pi-0-99/session-log.ts";
import {
  compactionCannotHelp,
  describeCompactionFailure,
  describePreflightPressure,
  describeUnrecoveredOverflow,
  OVERFLOW_RECOVERED,
  type ContextPressureNotice,
} from "../effectors/compaction-policy.ts";
import type { TurnFailure } from "../effectors/failure-classifier.ts";
import type { SessionLog } from "../effectors/contracts/session-log.ts";
import { RunGuard, RunGuardError } from "../effectors/run-guard.ts";
import { RunOutcome, type RunAbortReason } from "../effectors/run-outcome.ts";
import { formatTurnFailure } from "../effectors/failure-classifier.ts";
import { runGuardLimits, providerRequestTimeoutMs, RUN_GUARD_POLL_MS } from "./run-limits.ts";
import { errorMessage } from "../errors.ts";

type AgentRecord = typeof agents.$inferSelect;
type ModelRefRecord = typeof modelRefs.$inferSelect;
type ProviderConfigRecord = typeof providerConfigs.$inferSelect;
type SessionRecord = typeof sessions.$inferSelect;
export { abortAgentRun, createAgentRunEventStream, getActiveAgentRunForSession, whenRunFinished } from "./run-stream.ts";

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

/**
 * The invocation context every Pi call in a run is made under.
 *
 * Deliberately not cancellable. Pi requires a `Context` everywhere, and the
 * obvious move -- hanging the run's abort on it -- would be a behaviour change,
 * not a migration: 0.83 passed no signal at all, and the harness derives its own
 * cancellable child context around each provider and tool call from the gate
 * that `lane.abort()` trips. Aborting the outer context instead would also break
 * the cleanup calls that have to run *after* an abort.
 */
const runContext: PiContext = BACKGROUND_CONTEXT;
type ServerExecution = ReturnType<typeof createServerExecution>;

export type AgentRunInput = {
  agent: AgentRecord;
  session: SessionRecord;
  modelRef: ModelRefRecord;
  providerConfig?: ProviderConfigRecord;
  modelRuntime: ModelRuntime;
  thinkingLevel: Session["thinkingLevel"];
  promptInput?: PromptInput;
  /**
   * What the session the run is in adds to the agent: tools and instructions
   * that only make sense there, like an issue's `report_issue`. Offered on top
   * of the agent's own tools, and not gated by its permissions, which are about
   * reaching the outside world -- these only ever reach Carmel's own state.
   */
  sessionAddons?: SessionRunAddons;
};

export type SessionRunAddons = {
  tools: AgentHarnessTool<ExecutionToolContext>[];
  instructions: string;
};

/** Everything the run body and its finalization share, fixed at run startup. */
type AgentRun = AgentRunInput & {
  run: ActiveAgentRun;
  abort: HarnessAbortGate;
  /** Collects how the run ended, since the run body reports failures rather than throwing them. */
  outcome: RunOutcome;
  model: Model<Api>;
};

/**
 * Start a run with no observer attached.
 *
 * The HTTP path wraps this in an SSE stream; the scheduler does not, because
 * nobody is watching a task fire. The run does not care either way -- it was
 * always detached from the response, and `run.events` accumulates whether or
 * not anything is subscribed.
 *
 * The returned run is the handle: await `whenFinished(run)` to know it is over.
 */
export function startDetachedAgentRun(input: AgentRunInput): ActiveAgentRun {
  const abort = new HarnessAbortGate();
  const run = createActiveAgentRun({
    runId: randomId(),
    userId: input.session.userId,
    sessionId: input.session.id,
    abort: (reason) => abort.request(reason),
  });
  const model = resolveServerModelRef(serializeModelRef(input.modelRef), input.providerConfig, input.modelRuntime);

  queueMicrotask(() => void startAgentRun({ ...input, run, abort, outcome: new RunOutcome(), model }));
  return run;
}

/**
 * Drive one agent turn to completion. Failures are reported to observers rather
 * than thrown: this runs detached from the HTTP response, so `finalizeRun` in
 * the `finally` is the only thing that can release the run and its resources.
 */
async function startAgentRun(context: AgentRun) {
  const { run, abort, outcome, agent, session, model, thinkingLevel, promptInput } = context;
  if (run.started) return;
  run.started = true;

  const retry = new RetryBranch();
  const contextReporter = new ContextReporter(model.contextWindow, (event) => emitRunEvent(run, event));
  const guard = new RunGuard(runGuardLimits());
  let guardTimer: ReturnType<typeof setInterval> | undefined;
  let piSession: PiSession | undefined;
  // Hoisted because failure reporting and finalization both need it: the log is
  // how the failure messages are appended and how the session gets closed.
  let log: SessionLog | undefined;
  // Also hoisted: the harness has to be closed before the session can be, and
  // finalization runs on paths where the run never got past opening it.
  let harness: RunHarness | undefined;
  let execution: ServerExecution | undefined;
  let unsubscribe: (() => void) | undefined;
  let releaseLane: (() => void) | undefined;

  try {
    piSession = await openPiSession(session.id);
    execution = createServerExecution(agent, {
      signal: abort.signal,
      beforeCall() {
        if (guard.stop) throw new RunGuardError(guard.stop);
        const stop = guard.recordToolCall();
        if (stop) {
          abort.request("guard");
          throw new RunGuardError(stop);
        }
      },
      onActivity: () => guard.recordActivity(),
    });
    await execution.prepare(abort.signal);
    const opened = await openRunHarness({ ...context, piSession, execution });
    const { lane, activeToolNames } = opened;
    harness = opened.harness;
    releaseLane = opened.releaseLane;
    abort.attach(lane);
    unsubscribe = observeHarnessEvents(harness, (event: HarnessEvent) => {
      retry.observe(event);
      contextReporter.observe(event);
      if (event.type === "turn_end") {
        const failure = contextReporter.lastTurnFailure;
        outcome.recordTurnEnd({
          stopReason: event.message.stopReason,
          detail: failure ? formatTurnFailure(failure) : event.message.errorMessage,
        });
      }
      // Every event is a sign of life; only finished tool calls count against
      // the ceiling. Aborting through the same gate the HTTP path uses means a
      // guard stop tears down exactly like a user stop.
      const stop = event.type === "tool_end" ? guard.recordToolCall() : (guard.recordActivity(), undefined);
      if (stop) abort.request("guard");
      const projected = projectRunEvent(event, model.contextWindow);
      if (projected) emitRunEvent(run, projected);
    });
    // Catches what events cannot: a provider connection that opened and went
    // quiet, or a bash command the model launched without a timeout.
    guardTimer = setInterval(() => {
      if (guard.poll()) abort.request("guard");
    }, RUN_GUARD_POLL_MS);
    log = createPiSessionLog({ session: piSession, lane, context: runContext });

    // Abort can land at any moment; check wherever the run can still stop without
    // leaving the session branch half-rewound.
    if (abort.requested) {
      await lane.abort(runContext);
      return;
    }

    const prepared = await prepareAgentRunPrompt(log, promptInput);
    retry.arm(prepared.retryOriginalLeafId);
    await reconcileLaneConfiguration(lane, runContext, { model, thinkingLevel, activeToolNames });
    await reportPreflightPressure(context, log);
    if (abort.requested) {
      await retry.restore(log);
      await lane.abort(runContext);
      return;
    }

    await runHarnessPrompt({ harness, lane, context: runContext }, prepared.promptInput.text, prepared.promptInput.images);
    // Checked before the retry-abandonment test: a guard stop aborts mid-turn,
    // which is a plausible way to leave a retry unpersisted, and the guard is
    // the more useful of the two explanations.
    if (guard.stop) throw new RunGuardError(guard.stop);
    if (retry.isAbandoned) throw new Error("Retry completed without persisting the user message.");
    contextReporter.reportUnrecoveredOverflow();
  } catch (error) {
    await reportRunFailure(context, { log, retry, error });
  } finally {
    if (guardTimer) clearInterval(guardTimer);
    await finalizeRun(context, { piSession, harness, log, execution, unsubscribe, releaseLane });
  }
}

/**
 * Coordinates an abort that can arrive before, during, or after the harness
 * exists. The HTTP abort path calls `request()` from outside the run body, so
 * the flag and the harness handle have to live behind one object rather than as
 * two variables the run body and the abort callback both reach into.
 */
export class HarnessAbortGate {
  readonly #controller = new AbortController();
  #requested = false;
  #reason?: RunAbortReason;
  /** 0.85 moved `abort()` off the harness and onto the lane that owns the run. */
  #lane?: Pick<AgentLane, "abort">;

  get requested() {
    return this.#requested;
  }

  /** Cancels resource setup before the harness lane exists. */
  get signal() {
    return this.#controller.signal;
  }

  /** Who asked first. A guard stop and a person pressing stop can race; the first one is what happened. */
  get reason() {
    return this.#reason;
  }

  request(reason: RunAbortReason = "user") {
    this.#requested = true;
    this.#reason ??= reason;
    this.#controller.abort();
    void this.#lane?.abort(runContext);
  }

  attach(lane: Pick<AgentLane, "abort">) {
    this.#lane = lane;
  }

  release() {
    this.#lane = undefined;
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

  observe(event: HarnessEvent) {
    if (this.#originalLeafId && event.type === "message_end" && event.message.role === "user") {
      this.#messagePersisted = true;
    }
  }

  /** Armed, but the replacement user message was never written. */
  get isAbandoned() {
    return this.#originalLeafId !== undefined && !this.#messagePersisted;
  }

  async restore(log: Pick<SessionLog, "moveTo">) {
    if (this.#originalLeafId === undefined) return;
    await log.moveTo(this.#originalLeafId);
  }
}

async function openRunHarness(
  context: AgentRun & { piSession: PiSession; execution: ServerExecution },
): Promise<{ harness: RunHarness; lane: AgentLane; activeToolNames: string[]; releaseLane: () => void }> {
  const { agent, piSession, execution, model, modelRuntime, thinkingLevel, sessionAddons } = context;
  const resources = await loadAgentResources(agent, execution.env);
  const tools = execution.resolveTools(sessionAddons?.tools);
  const activeToolNames = tools.map((tool) => tool.name);
  // 0.85 replaced the constructor with a factory: it restores durable lane and
  // operation state from the session, and reports what it found still open.
  const { harness } = await AgentHarness.create<ExecutionToolContext>({
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
      sessionInstructions: sessionAddons?.instructions,
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
    // `timeoutMs` was missing, so a provider connection that opened and never
    // answered held the run -- and the session's mutation lease -- for the life
    // of the process.
    streamOptions: { timeoutMs: providerRequestTimeoutMs(), maxRetries: 2, maxRetryDelayMs: 60_000 },
    // Distinct from `streamOptions`, which only covers turn streaming. Without
    // this, a transient provider error during summarization ended compaction for
    // the turn -- on the one call the session most needs to succeed.
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
    // Threshold compaction on a window it cannot work in buys a summarization
    // call at every step and leaves the session over budget. Switched off there;
    // Pi's overflow recovery does not read `enabled` and stays available.
    compaction: compactionCannotHelp(model.contextWindow)
      ? { ...DEFAULT_COMPACTION_SETTINGS, enabled: false }
      : DEFAULT_COMPACTION_SETTINGS,
  }, runContext);
  registerCodemodeResultHook(harness);
  // Acquiring the lane is what creates the conversation branch on a new session
  // and restores it on an existing one. Everything that runs the loop hangs off
  // this handle rather than off the harness.
  const lane = await harness.lane(PI_MAIN_BRANCH, runContext);
  // Reads of this session during the run follow the lane rather than the stored
  // branch tip, which 0.85 only publishes at operation boundaries.
  const releaseLane = registerPiSessionLane(piSession, lane);
  return { harness, lane, activeToolNames, releaseLane };
}

/** Restore an abandoned retry branch, then persist and emit the failure. */
async function reportRunFailure(
  context: AgentRun,
  state: { log?: SessionLog; retry: RetryBranch; error: unknown },
) {
  const { log, retry, error } = state;
  if (log && retry.isAbandoned) {
    try {
      await retry.restore(log);
    } catch (restoreError) {
      console.warn("Retry branch restoration failed:", errorMessage(restoreError));
    }
  }

  const errorEvent = createAgentError(error, context.model);
  context.outcome.recordThrown(formatTurnFailure(errorEvent.failure));
  try {
    if (log) {
      for (const message of errorEvent.messages) await log.appendMessage(message);
    }
  } catch (persistenceError) {
    console.warn("Session error persistence failed:", errorMessage(persistenceError));
    context.outcome.recordPersistenceFailure(errorMessage(persistenceError));
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
  state: {
    piSession?: PiSession;
    harness?: RunHarness;
    log?: SessionLog;
    execution?: ServerExecution;
    unsubscribe?: () => void;
    releaseLane?: () => void;
  },
) {
  const { run, abort, outcome, session, modelRef, model, modelRuntime, thinkingLevel } = context;
  const { piSession, harness, log, execution, unsubscribe, releaseLane } = state;

  let finalMessages: AgentMessage[] = [];
  if (piSession) {
    try {
      if (log) {
        finalMessages = (await log.readBranch()).flatMap((entry) =>
          entry.type === "message" ? [entry.message] : [],
        );
      }
    } catch (error) {
      console.warn("Final transcript read failed:", errorMessage(error));
    }
    // Before the harness closes: another holder of this session -- an HTTP read
    // -- can outlive the run, and must go back to reading the stored branch
    // rather than a lane that no longer exists.
    releaseLane?.();
    try {
      // Order matters: `session.close()` seals the mutation line and waits for
      // it to drain, so a session whose harness is still open never finishes
      // closing. The harness tears down its hooks, events and idle callbacks
      // and closes the session itself; releasing the lease after that is
      // idempotent and just drops this run's hold on the handle.
      await harness?.close(runContext);
      await (log ? log.close() : closePiSession(piSession));
    } catch (error) {
      // Closing is what drains the session's pending writes, so a failure here
      // can mean the transcript is short of what the run produced.
      console.warn("Pi session cleanup failed:", errorMessage(error));
      outcome.recordPersistenceFailure(errorMessage(error));
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
    outcome.recordPersistenceFailure(errorMessage(error));
  }

  unsubscribe?.();
  try {
    await execution?.cleanup(runContext);
  } catch (error) {
    console.warn("Execution environment cleanup failed:", errorMessage(error));
  } finally {
    abort.release();
    // Sequenced terminal authority for observers: it follows every persistence
    // and title finalization attempt, and the execution cleanup.
    const result = outcome.result(abort.reason);
    emitRunEvent(run, { type: "run_finished", result });
    finishAgentRun(run, result);
    try {
      recordSessionActivity(session.id, run.runId, result);
    } catch (error) {
      console.warn("Could not record session activity:", errorMessage(error));
    }
  }
}

/**
 * A run without prompt input is a retry/edit-and-resend. The active branch
 * already ends in the user message, so rewind to its parent and send that same
 * content through AgentHarness.prompt(). This preserves the abandoned branch
 * without inserting the empty user message that prompt("") would create.
 */
export async function prepareAgentRunPrompt(
  log: Pick<SessionLog, "readBranch" | "moveTo">,
  promptInput?: PromptInput,
): Promise<{ promptInput: PromptInput; retryOriginalLeafId?: string }> {
  if (promptInput) return { promptInput };

  const branch = await log.readBranch();
  const lastEntry = branch.at(-1);
  if (lastEntry?.type !== "message" || lastEntry.message.role !== "user") {
    throw new Error("Cannot retry: the active session branch must end in a user message.");
  }

  const retryPromptInput = promptInputFromUserMessage(
    lastEntry.message as Extract<AgentMessage, { role: "user" }>,
  );
  await log.moveTo(lastEntry.parentId);
  return {
    promptInput: retryPromptInput,
    retryOriginalLeafId: lastEntry.id,
  };
}

/**
 * Dispatch composer text to the agent loop.
 *
 * The rule -- which slash commands exist and which wins when a name is
 * ambiguous -- lives in `effectors/dispatch-prompt.ts` with no Pi imports; the
 * Pi-shaped parts (invocation formatting, argument parsing, inlining a named
 * invocation that carries an attachment) live in the `pi-0-99` adapter.
 */
export async function runHarnessPrompt(
  dispatch: PiDispatcherOptions,
  text: string,
  images?: PromptInput["images"],
) {
  return dispatchPrompt(createPiPromptDispatcher(dispatch), text, images);
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

/**
 * Warn before the turn when the session is over budget on a model whose window
 * compaction cannot work in -- Pi would find out from a provider rejection.
 * Never ends the run: this is a measurement, and a notice is all it produces.
 */
async function reportPreflightPressure(context: AgentRun, log: SessionLog) {
  try {
    const notice = describePreflightPressure({
      tokens: await estimateBranchTokens(log),
      contextWindow: context.model.contextWindow,
    });
    if (notice) emitContextPressure(context, notice);
  } catch (error) {
    console.warn("Context pressure check failed:", errorMessage(error));
  }
}

function emitContextPressure(context: AgentRun, notice: ContextPressureNotice) {
  console.warn(`Context pressure on session ${context.session.id}: ${notice.message}`);
  emitRunEvent(context.run, { type: "context_pressure", level: notice.level, message: notice.message });
}

/**
 * Reports Pi's own compaction to the user; Carmel does no compacting itself.
 *
 * Pi 0.85 compacts at every checkpoint and, when a generation overflows,
 * compacts and retries it once. The overflowed attempt's `turn_end` has already
 * reached the client as an error by then, so a successful recovery has to be
 * announced to clear it. What is left afterwards -- an overflow the run still
 * ended on -- is only reportable: compaction was the whole remedy.
 */
export class ContextReporter {
  #lastTurnFailure?: TurnFailure;
  #overflowCompaction: "none" | "completed" | "failed" = "none";
  readonly #contextWindow?: number;
  readonly #emit: (event: AgentRunEvent) => void;

  /** The model's window, so a silent overflow -- a `stop` that overran -- is seen. */
  constructor(contextWindow: number | undefined, emit: (event: AgentRunEvent) => void) {
    this.#contextWindow = contextWindow;
    this.#emit = emit;
  }

  observe(event: HarnessEvent) {
    if (event.type === "turn_end") {
      // A clean turn clears the record: only the last turn decides the run.
      this.#lastTurnFailure = classifyHarnessTurnFailure(event, this.#contextWindow);
      return;
    }
    if (event.type !== "compaction_end") return;
    if (event.status === "failed") {
      if (event.reason === "overflow") this.#overflowCompaction = "failed";
      const notice = describeCompactionFailure(event.error.message);
      this.#emit({ type: "context_pressure", level: notice.level, message: notice.message });
    } else if (event.status === "completed" && event.reason === "overflow") {
      this.#overflowCompaction = "completed";
      this.#emit({ type: "run_recovered", message: OVERFLOW_RECOVERED });
    }
  }

  /** The failure the most recent turn ended with, if any. */
  get lastTurnFailure() {
    return this.#lastTurnFailure;
  }

  /** Call once the prompt returns. A failed compaction already said its piece. */
  reportUnrecoveredOverflow() {
    if (this.#lastTurnFailure?.category !== "context_overflow" || this.#overflowCompaction === "failed") return;
    const notice = describeUnrecoveredOverflow(this.#overflowCompaction === "completed");
    this.#emit({ type: "context_pressure", level: notice.level, message: notice.message });
  }
}

/**
 * Mirrors the `customPrompt` branch of pi-coding-agent's `buildSystemPrompt`
 * (project context, skills, working directory), which Pi does not export.
 * Keep the layout in step with it when upgrading Pi.
 */
function buildHarnessSystemPrompt(options: {
  base: string;
  cwd: string;
  skills: Parameters<typeof formatSkillsForSystemPrompt>[0];
  contextFiles: Array<{ path: string; content: string }>;
  includeSkills: boolean;
  sessionInstructions?: string;
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
  if (options.sessionInstructions) prompt += `\n\n${options.sessionInstructions}`;
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
  const committedRevision = commitSessionAtRevision(session.id, session.revision, {
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
    const title = await generateSessionTitle({
      model: titleModelContext.model,
      modelRuntime: titleModelContext.modelRuntime,
      messages: patch.messages,
    });
    if (!title) return;
    if (commitSessionAtRevision(session.id, committedRevision, { title, updatedAt: now() }) === undefined) {
      console.warn(`Skipped stale title update for session ${session.id}.`);
    }
  } catch (error) {
    console.warn(
      "Session title generation failed:",
      errorMessage(error),
    );
  }
}

/**
 * Write to the session row only if it still has `expectedRevision`, advancing
 * it by one. Returns the new revision, or undefined when a newer mutation got
 * there first and this write was dropped.
 */
export function commitSessionAtRevision(
  sessionId: string,
  expectedRevision: number,
  patch: Partial<Pick<SessionRecord, "modelRefId" | "thinkingLevel" | "title" | "updatedAt">>,
) {
  const revision = expectedRevision + 1;
  const result = db
    .update(sessions)
    .set({ ...patch, revision })
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

  const result = await resolveModelContext(userId, fastTaskModelRefId);
  if (!result.ok) return fallback;
  return {
    model: result.value.model,
    modelRuntime: result.value.modelRuntime,
  };
}
