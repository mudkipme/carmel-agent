import { createHelperExtension, helperTasks } from "./helpers.ts";
import { retainHelperHost } from "./helper-hosts.ts";
import { createHomeTools, homeInstructions } from "./home-tools.ts";
import { createSessionSearchTools } from "./session-search-tools.ts";
import { sessionHome } from "../services/agent-homes.ts";
import { CompactionEntry, GenerationTask, hook } from "@earendil-works/pi-durable";
import {
  PiRun,
  BACKGROUND_CONTEXT,
  formatSkillsForSystemPrompt,
  type Conversation,
  type Context as PiContext,
  type AgentEvent,
  type AgentMessage,
} from "../effectors/pi-durable/index.ts";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { agents, modelRefs, providerConfigs, sessions, users } from "../db/schema.ts";
import { serializeModelRef } from "../serializers.ts";
import {
  closePiSession,
  openPiSession,
  readPiSessionTitleMessages,
} from "../services/pi-session-storage.ts";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { resolveModelContext } from "../services/model-context.ts";

import { type AgentRunEvent, type PromptInput, type Session } from "@carmel-agent/shared";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createAgentError, resolveServerModelRef } from "./model.ts";
import { loadAgentResources } from "./resources.ts";
import { classifyAssistantFailure, projectRunEvent } from "./run-events.ts";
import {
  createActiveAgentRun,
  emitRunEvent,
  finishAgentRun,
  type ActiveAgentRun,
} from "./run-stream.ts";
import {
  generateSessionTitle,
  isPlaceholderTitle,
  shouldGenerateSessionTitle,
} from "./session-title.ts";
import { createServerExecution } from "./tools.ts";
import { dispatchPrompt } from "../effectors/dispatch-prompt.ts";
import { type PromptDispatch } from "../effectors/dispatch-prompt.ts";
import { createPiSessionLog } from "../effectors/pi-durable/session-log.ts";
import {
  compactionSettingsForWindow,
  describeCompactionFailure,
  describeUnrecoveredOverflow,
  OVERFLOW_RECOVERED,
} from "../effectors/compaction-policy.ts";
import type { TurnFailure } from "../effectors/failure-classifier.ts";
import type { SessionLog } from "../effectors/contracts/session-log.ts";
import { RunGuard, RunGuardError } from "../effectors/run-guard.ts";
import { RunOutcome, type RunAbortReason } from "../effectors/run-outcome.ts";
import { formatTurnFailure } from "../effectors/failure-classifier.ts";
import { runGuardLimits, providerRequestTimeoutMs, RUN_GUARD_POLL_MS } from "./run-limits.ts";
import { errorMessage } from "../errors.ts";
import { browserControl } from "./browser-control.ts";
import { resolvePromptReferences, type ResolvedReferences } from "../services/prompt-references.ts";
import { getMessageReferences } from "@carmel-agent/shared";
import { browserInstructions } from "./browser-tools.ts";
import { formatBuiltinSkillsForSystemPrompt, isBuiltinSkill } from "./builtin-skills.ts";
import { buildKnowledgeInstructions } from "./knowledge/prompt.ts";
import { createScheduleTaskTool, buildSchedulingInstructions } from "./task-tools.ts";
import { createUserRequestTools, userRequestInstructions } from "./user-request-tools.ts";
import {
  blockingUserRequest,
  markUserReplySubmitted,
  pendingUserReply,
} from "../services/user-requests.ts";
import {
  createSendUserMessageTool,
  messagingInstructions,
  notificationPlatforms,
} from "./im-tools.ts";

type AgentRecord = typeof agents.$inferSelect;
type ModelRefRecord = typeof modelRefs.$inferSelect;
type ProviderConfigRecord = typeof providerConfigs.$inferSelect;
type SessionRecord = typeof sessions.$inferSelect;
export {
  abortAgentRun,
  createAgentRunEventStream,
  getActiveAgentRunForSession,
  whenRunFinished,
} from "./run-stream.ts";

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
  if (!text.trim() && (!images || images.length === 0) && !input.references?.length) {
    throw new Error("Prompt input text or image content is required.");
  }
  return {
    text,
    images: images && images.length > 0 ? images : undefined,
    ...(input.references?.length ? { references: input.references } : {}),
  } satisfies PromptInput;
}

type PiSession = Awaited<ReturnType<typeof openPiSession>>;
type RunHarness = PiRun;

/**
 * The invocation context every Pi call in a run is made under.
 *
 * Native conversation abort cancels its provider/tool invocations. Keep the
 * outer context alive so its event stream can deliver settlement and cleanup
 * can commit after cancellation.
 */
const runContext: PiContext = BACKGROUND_CONTEXT;
type ServerExecution = ReturnType<typeof createServerExecution>;

export type AgentRunInput = {
  notifyPlatform?: import("@carmel-agent/shared").ImPlatform;
  agent: AgentRecord;
  session: SessionRecord;
  modelRef: ModelRefRecord;
  providerConfig?: ProviderConfigRecord;
  modelRuntime: Models;
  thinkingLevel: Session["thinkingLevel"];
  promptInput?: PromptInput;
  promptDelivery?: {
    requestId: string;
    source: Record<string, import("@earendil-works/chord").JsonValue>;
  };
  resolvedReferences?: ResolvedReferences;
  /** Browser time zone for interpreting local reminder times. */
  timezone?: string;
  /**
   * What the session the run is in adds to the agent: tools and instructions
   * that only make sense there, like an issue's `report_issue`. Offered on top
   * of the agent's own tools, and not gated by its permissions, which are about
   * reaching the outside world -- these only ever reach Carmel's own state.
   */
  sessionAddons?: SessionRunAddons;
};

export type SessionRunAddons = {
  tools: ToolRegistration[];
  instructions: string;
  onQueueUpdate?: (entryIds: string[]) => void;
  onRunSettling?: (session: PiSession, aborted: boolean) => Promise<void>;
};

const runningConversations = new Map<string, Conversation>();
/** Native submission records own steering admission and queue state. */
export async function steerAgentRun(sessionId: string, text: string) {
  const conversation = runningConversations.get(sessionId);
  if (!conversation) return undefined;
  const submission = await conversation.submit(
    { type: "input", content: text, whenBusy: "steer" },
    runContext,
  );
  const record = await submission.status(runContext);
  return {
    entryId: record.status === "placed" ? `durable:${record.entry}` : `submission:${submission.id}`,
    pending: record.status === "queued",
  };
}

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
 * Background callers (the scheduler, issues, IM) use this. Chat does not: it
 * admits the run and returns the id before this work starts, so a stop has a
 * server run to cancel before the model is called. `run.events` accumulates
 * whether or not anything is subscribed.
 *
 * The returned run is the handle: await `whenRunFinished(run)` to know it is over.
 */
export function startDetachedAgentRun(input: AgentRunInput): ActiveAgentRun {
  const context = createAgentRun(input);
  queueMicrotask(() => void startAgentRun(context));
  return context.run;
}

/**
 * Register a chat run and start it on the next turn.
 *
 * The HTTP handler returns this id before the timer fires. A stop in between
 * cancels the run inside `startAgentRun`, before the provider is called.
 */
export function admitAgentRun(input: AgentRunInput): ActiveAgentRun {
  const context = createAgentRun(input);
  setImmediate(() => void startAgentRun(context));
  return context.run;
}

function createAgentRun(input: AgentRunInput): AgentRun {
  if (input.promptInput && blockingUserRequest(input.session.id))
    throw new Error("Respond to the pending request before sending another message.");
  const abort = new HarnessAbortGate();
  const run = createActiveAgentRun({
    runId: randomId(),
    userId: input.session.userId,
    sessionId: input.session.id,
    abort: (reason) => abort.request(reason),
  });
  const model = resolveServerModelRef(
    serializeModelRef(input.modelRef),
    input.providerConfig,
    input.modelRuntime,
  );
  return { ...input, run, abort, outcome: new RunOutcome(), model };
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
  // Chat returns the run id, then starts on a later turn. A stop that arrived
  // in between has to end here, before the session is opened or the model called.
  if (abort.requested) {
    const result = outcome.result(abort.reason);
    emitRunEvent(run, { type: "run_finished", result });
    finishAgentRun(run, result);
    return;
  }

  const retry = new RetryBranch();
  const contextReporter = new ContextReporter(model.contextWindow, (event) =>
    emitRunEvent(run, event),
  );
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

  try {
    piSession = await openPiSession(session.id);
    execution = createServerExecution(
      agent,
      {
        signal: abort.signal,
        beforeCall() {
          if (guard.stop) throw new RunGuardError(guard.stop);
          const stop = guard.recordToolCall();
          if (stop) {
            abort.request("guard");
            throw new RunGuardError(stop);
          }
        },
      },
      session.userId,
      session.id,
    );
    await execution.prepare(abort.signal);
    const opened = await openRunHarness({ ...context, piSession, execution });
    const { conversation, tools, resources } = opened;
    runningConversations.set(session.id, conversation);
    harness = opened.harness;
    abort.attach(conversation);
    unsubscribe = harness.observe((event: AgentEvent) => {
      if (!abort.requested && (event.type === "inbox_update" || event.type === "snapshot"))
        context.sessionAddons?.onQueueUpdate?.(
          (event.type === "inbox_update" ? event.items : event.inbox).map(
            (item) => `submission:${item.id}`,
          ),
        );
      retry.observe(event);
      contextReporter.observe(event);
      if (event.type === "message_end" && event.entry.model?.[0]?.role === "assistant") {
        const message = event.entry.model[0];
        const failure = contextReporter.lastTurnFailure;
        outcome.recordTurnEnd({
          stopReason: message.stopReason,
          detail: failure ? formatTurnFailure(failure) : message.errorMessage,
        });
      }
      // Every event is a sign of life; only finished tool calls count against
      // the ceiling. Aborting through the same gate the HTTP path uses means a
      // guard stop tears down exactly like a user stop.
      const stop =
        event.type === "tool_execution_end" && !event.parentToolCallId
          ? guard.recordToolCall()
          : (guard.recordActivity(), undefined);
      if (stop) abort.request("guard");
      const projected = projectRunEvent(event, contextReporter.lastTurnFailure);
      if (projected) emitRunEvent(run, projected);
    });
    contextReporter.observe(harness.snapshot);
    // Catches what events cannot: a provider connection that opened and went
    // quiet, or a bash command the model launched without a timeout.
    guardTimer = setInterval(() => {
      if (
        agent.permissions.bash &&
        browserControl(agent.id).isPaused &&
        !browserControl(agent.id).isDraining
      ) {
        guard.recordActivity();
        return;
      }
      if (guard.poll()) abort.request("guard");
    }, RUN_GUARD_POLL_MS);
    log = createPiSessionLog({ session: piSession, onNavigate: () => harness!.attach() });

    // Abort can land at any moment; check wherever the run can still stop without
    // leaving the session branch half-rewound.
    if (abort.requested) {
      await conversation.abort(runContext);
      return;
    }

    await conversation.configure(
      { model: { provider: model.provider, modelId: model.id }, thinkingLevel, tools },
      runContext,
    );
    if (abort.requested) {
      await retry.restore(log);
      await conversation.abort(runContext);
      return;
    }

    const userReply = !promptInput ? pendingUserReply(session.id) : undefined;
    if (userReply) {
      if (userReply.conversationId !== String(conversation.id))
        throw new Error("The request belongs to an earlier conversation branch.");
      await harness.prompt(userReply.text, undefined, runContext, undefined, {
        requestId: userReply.requestId,
        receipt: userReply.receipt,
        onSubmitted: () => markUserReplySubmitted(userReply.id),
      });
    } else if (!promptInput && (await harness.hasPending(runContext))) {
      // A restart continues Durable's checkpoint instead of rewinding and resubmitting the user input.
      await harness.resume(runContext);
    } else {
      const prepared = await prepareAgentRunPrompt(log, promptInput);
      retry.arm(prepared.retryOriginalLeafId);
      const resolved =
        context.resolvedReferences ??
        (await resolvePromptReferences(
          session.userId,
          agent,
          session.id,
          prepared.promptInput.references,
        ));
      await runHarnessPrompt(
        {
          resources,
          prompt: (text, images) =>
            harness!.prompt(text, images, runContext, resolved, context.promptDelivery),
        },
        prepared.promptInput.text,
        prepared.promptInput.images,
      );
    }
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
    runningConversations.delete(session.id);
    if (piSession && context.sessionAddons?.onRunSettling) {
      try {
        await context.sessionAddons.onRunSettling(piSession, abort.requested);
      } catch (error) {
        console.warn("Unable to settle issue updates:", errorMessage(error));
      }
    }
    await finalizeRun(context, { piSession, harness, log, execution, unsubscribe });
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
  /** Abort the selected native conversation once it is attached. */
  #lane?: Pick<Conversation, "abort">;

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

  attach(lane: Pick<Conversation, "abort">) {
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

  observe(event: AgentEvent) {
    if (
      this.#originalLeafId &&
      event.type === "message_end" &&
      event.entry.model?.[0]?.role === "user"
    ) {
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
) {
  const { agent, piSession, execution, model, modelRuntime, thinkingLevel, sessionAddons } =
    context;
  const resources = await loadAgentResources(agent, execution.env);
  const helperExtension = !sessionHome(context.session.id)
    ? createHelperExtension({
        sessionId: context.session.id,
        userId: context.session.userId,
        agentId: agent.id,
      })
    : undefined;
  const messagingPlatforms = notificationPlatforms(context.session.userId, agent.id);
  const schedulingTools = context.session.taskId
    ? []
    : [
        createScheduleTaskTool({
          userId: context.session.userId,
          agentId: agent.id,
          modelRefId: context.modelRef.id,
          thinkingLevel,
          timezone: context.timezone,
        }),
      ];
  const messagingTools = messagingPlatforms.length
    ? [
        createSendUserMessageTool({
          userId: context.session.userId,
          agentId: agent.id,
          sessionId: context.session.id,
        }),
      ]
    : [];
  const tools = execution.resolveTools([
    ...(!context.session.issueId
      ? createUserRequestTools({
          sessionId: context.session.id,
          userId: context.session.userId,
          bash: agent.permissions.bash,
        })
      : []),
    ...(helperExtension?.tools ?? []),
    ...createSessionSearchTools(context.session.userId, agent.id),
    ...(sessionHome(context.session.id) ? createHomeTools(context.session.userId, agent.id) : []),
    ...schedulingTools,
    ...messagingTools,
    ...(sessionAddons?.tools ?? []),
  ]);
  const activeToolNames = tools.map((tool) => tool.name);
  // Install this run's credentials, resources, and permitted tools before native scheduling.
  const harness = await PiRun.open(
    piSession,
    {
      models: modelRuntime,
      agent: { model: { provider: model.provider, modelId: model.id }, thinkingLevel, tools },
      sections: {
        user_requests: !context.session.issueId
          ? userRequestInstructions(
              context.session.userId,
              context.session.id,
              agent.permissions.bash,
            )
          : undefined,
        messaging:
          messagingPlatforms.length || context.notifyPlatform
            ? messagingInstructions(messagingPlatforms, context.notifyPlatform)
            : undefined,
        ...buildHarnessPromptSections({
          base: agent.systemPrompt.trim() || "You are a helpful assistant.",
          cwd: execution.env.cwd,
          skills: resources.skills,
          contextFiles: resources.contextFiles,
          includeSkills: activeToolNames.includes("read"),
        }),
        home: sessionHome(context.session.id)
          ? `${homeInstructions}${agent.id}/issues/:issueId. Ask which issue if the target is ambiguous. Keep issue updates conversational and concise: state the outcome or question, with a link when useful. Leave checks, artifacts, logs, and uncertainty on the issue page. Use session_search to recover older decisions. Private chat facts must not be automatically saved into agent-shared memory.`
          : undefined,
        issue: sessionAddons?.instructions,
        browser: agent.permissions.bash ? browserInstructions : undefined,
        knowledge:
          buildKnowledgeInstructions(context.session.userId, agent.id, activeToolNames) ||
          undefined,
        scheduling: schedulingTools.length
          ? buildSchedulingInstructions(context.timezone, messagingPlatforms)
          : undefined,
      },
      tools,
      env: execution.env,
      extensions: [
        helperTasks,
        ...(helperExtension ? [helperExtension] : []),
        ...execution.extensions,
        ...(agent.permissions.bash
          ? [
              {
                name: "carmel.browser",
                hooks: [
                  hook(GenerationTask, {
                    async beforeRequest() {
                      await browserControl(agent.id).wait(context.abort.signal);
                    },
                  }),
                ],
              },
            ]
          : []),
      ],
      settings: {
        progress: { partialIntervalMs: 50, outputIntervalMs: 50 },
        // `timeoutMs` was missing, so a provider connection that opened and never
        // answered held the run -- and the session's mutation lease -- for the life
        // of the process.
        stream: {
          timeoutMs: providerRequestTimeoutMs(),
          maxRetries: 2,
          maxRetryDelayMs: 60_000,
        },
        // Distinct from `stream settings`, which only covers turn streaming. Without
        // this, a transient provider error during summarization ended compaction for
        // the turn -- on the one call the session most needs to succeed.
        retry: { maxRetries: 2, baseDelayMs: 1_000 },
        compaction: compactionSettingsForWindow(model.contextWindow),
      },
    },
    runContext,
  );
  const dispatchResources = {
    skills: resources.skills,
    promptTemplates: [
      ...resources.promptTemplates,
      ...agent.promptTemplates.map((template) => ({
        name: template.name,
        content: template.body,
      })),
    ],
  };
  return { harness, conversation: piSession.conversation, tools, resources: dispatchResources };
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
  },
) {
  const { run, abort, outcome, session, modelRef, model, modelRuntime, thinkingLevel } = context;
  const { piSession, harness, log, execution, unsubscribe } = state;

  let keepExecution = false;
  let finalMessages: AgentMessage[] = [];
  if (piSession) {
    try {
      if (isPlaceholderTitle(session.title))
        finalMessages = await readPiSessionTitleMessages(piSession);
    } catch (error) {
      console.warn("Final transcript read failed:", errorMessage(error));
    }
    try {
      // Detach event delivery before releasing native storage. HTTP readers
      // retain their own leases and continue reading committed progress.
      await harness?.close();
      if (execution) keepExecution = await retainHelperHost(piSession, execution);
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
    if (!keepExecution) await execution?.cleanup(runContext);
  } catch (error) {
    console.warn("Execution environment cleanup failed:", errorMessage(error));
  } finally {
    abort.release();
    // Sequenced terminal authority for observers: it follows every persistence
    // and title finalization attempt, and the execution cleanup.
    const result = outcome.result(abort.reason);
    emitRunEvent(run, { type: "run_finished", result });
    finishAgentRun(run, result);
  }
}

/**
 * A run without prompt input is a retry/edit-and-resend. The active branch
 * already ends in the user message, so rewind to its parent and send that same
 * content through native Conversation.submit(). This preserves the abandoned branch
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
 * invocation that carries an attachment) live in the `pi-durable` adapter.
 */
export async function runHarnessPrompt(
  dispatch: PromptDispatch,
  text: string,
  images?: PromptInput["images"],
) {
  return dispatchPrompt(dispatch, text, images);
}

function promptInputFromUserMessage(message: Extract<AgentMessage, { role: "user" }>): PromptInput {
  const references = getMessageReferences(message);
  if (typeof message.content === "string") {
    if (!message.content.trim() && !references.length)
      throw new Error("Cannot retry an empty user message.");
    return { text: message.content, ...(references.length ? { references } : {}) };
  }

  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const images = message.content.filter((part) => part.type === "image");
  if (!text.trim() && images.length === 0 && !references.length)
    throw new Error("Cannot retry an empty user message.");
  return {
    text,
    images: images.length > 0 ? images : undefined,
    ...(references.length ? { references } : {}),
  };
}

/**
 * Reports Pi's own compaction to the user; Carmel does no compacting itself.
 *
 * Pi Durable checks context before generation and, when a generation overflows,
 * compacts and retries it once. The overflowed attempt's `turn_end` has already
 * reached the client as an error by then, so a successful recovery has to be
 * announced to clear it. What is left afterwards -- an overflow the run still
 * ended on -- is only reportable: compaction was the whole remedy.
 */
export class ContextReporter {
  #lastTurnFailure?: TurnFailure;
  #overflowCompaction: "none" | "completed" | "failed" = "none";
  #reportedCompactionFailure?: number;
  readonly #contextWindow?: number;
  readonly #emit: (event: AgentRunEvent) => void;

  /** The model's window, so a silent overflow -- a `stop` that overran -- is seen. */
  constructor(contextWindow: number | undefined, emit: (event: AgentRunEvent) => void) {
    this.#contextWindow = contextWindow;
    this.#emit = emit;
  }

  observe(event: AgentEvent) {
    if (event.type === "message_end" && event.entry.model?.[0]?.role === "assistant") {
      this.#lastTurnFailure = classifyAssistantFailure(event.entry.model[0], this.#contextWindow);
      return;
    }
    if (
      (event.type === "message_end" || event.type === "entry_appended") &&
      event.entry.kind === CompactionEntry.kind &&
      (event.entry.data as { reason?: string } | undefined)?.reason === "overflow"
    ) {
      this.#overflowCompaction = "completed";
      this.#emit({ type: "run_recovered", message: OVERFLOW_RECOVERED });
      return;
    }
    const failure =
      event.type === "snapshot"
        ? event.compactionFailure
        : event.type === "compaction_end" && event.error
          ? event
          : undefined;
    if (!failure || failure.taskId === this.#reportedCompactionFailure) return;
    this.#reportedCompactionFailure = failure.taskId;
    if (failure.reason === "overflow") this.#overflowCompaction = "failed";
    const notice = describeCompactionFailure(failure.error!);
    this.#emit({ type: "context_pressure", level: notice.level, message: notice.message });
  }

  /** The failure the most recent turn ended with, if any. */
  get lastTurnFailure() {
    return this.#lastTurnFailure;
  }

  /** Call once the prompt returns. A failed compaction already said its piece. */
  reportUnrecoveredOverflow() {
    if (
      this.#lastTurnFailure?.category !== "context_overflow" ||
      this.#overflowCompaction === "failed"
    )
      return;
    const notice = describeUnrecoveredOverflow(this.#overflowCompaction === "completed");
    this.#emit({ type: "context_pressure", level: notice.level, message: notice.message });
  }
}

/** Named sections let Durable store only changed instructions between runs. */
function buildHarnessPromptSections(options: {
  base: string;
  cwd: string;
  skills: Parameters<typeof formatSkillsForSystemPrompt>[0];
  contextFiles: Array<{ path: string; content: string }>;
  includeSkills: boolean;
}) {
  return {
    system: options.base,
    project_context: options.contextFiles.length
      ? `<project_context>\n\nProject-specific instructions and guidelines:\n\n${options.contextFiles.map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`).join("\n\n")}\n\n</project_context>`
      : undefined,
    skills: options.includeSkills
      ? formatSkillsForSystemPrompt(options.skills.filter((skill) => !isBuiltinSkill(skill))) ||
        undefined
      : undefined,
    builtin_skills: formatBuiltinSkillsForSystemPrompt(options.skills) || undefined,
    cwd: `Current working directory: ${options.cwd.replaceAll("\\", "/")}`,
  };
}

function randomId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  );
}

async function persistSessionRun(
  session: SessionRecord,
  patch: {
    messages: AgentMessage[];
    modelRefId: string;
    thinkingLevel: Session["thinkingLevel"];
    model: ReturnType<typeof resolveServerModelRef>;
    modelRuntime: Models;
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
    if (
      commitSessionAtRevision(session.id, committedRevision, { title, updatedAt: now() }) ===
      undefined
    ) {
      console.warn(`Skipped stale title update for session ${session.id}.`);
    }
  } catch (error) {
    console.warn("Session title generation failed:", errorMessage(error));
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
  fallback: { model: Model<Api>; modelRuntime: Models },
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
