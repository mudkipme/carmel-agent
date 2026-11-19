import { i18n } from "@lingui/core";
import { apiRoutes } from "@carmel-agent/shared/api";
import type {
  AgentMessage,
  Api,
  ImageContent,
  Model,
  ThinkingLevel,
} from "@carmel-agent/shared/pi";
import type {
  ActiveAgentRunSummary,
  AgentRunEventEnvelope,
  PromptInput,
  RunProgress,
  Session,
  SessionConnection,
  UserRequest,
} from "@carmel-agent/shared";
import { api, ApiError, apiError, apiFetch, apiUrl } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  applyConnectionToState,
  applyHistoryEntryPage,
  applyLiveProgress,
  applyRunEvent,
  buildAgentSnapshot,
  confirmPendingMessage,
  createTranscriptState,
  normalizePromptInput,
  prependOlderHistoryPage,
  type AgentConnection,
  type AgentSnapshot,
  type ContextPressure,
  type PendingMessage,
  type PromptOutcome,
  type TranscriptState,
} from "./remote-agent-state.ts";
import { openRunEventStream, type RunEventStream } from "./update-connection.ts";

export type { AgentConnection, AgentSnapshot, ContextPressure, PromptOutcome };

export class RemoteAgent {
  private storeListeners = new Set<() => void>();
  private state: TranscriptState;
  private snapshotValue: AgentSnapshot;
  private abortController?: AbortController;
  private isStreaming = false;
  private reconnectError?: string;
  private runId?: string;
  private lastSequence = 0;
  private runFinished = false;
  private detachRequested = false;
  /**
   * A stop can arrive while admission is still in flight. The id comes back
   * before the model is called, and this is sent as soon as that id exists.
   */
  private stopRequested = false;
  private connectionRefresh = 0;
  private refreshWhenIdle = false;

  constructor(
    private readonly config: {
      agentId: string;
      sessionId: string;
      modelRefId: string;
      model: Model<Api>;
      thinkingLevel: ThinkingLevel;
      messages: AgentMessage[];
      messageEntryIds?: string[];
      home?: boolean;
      olderCursor?: string;
      onConnection?: (connection: SessionConnection) => void;
      onHistoryPage?: (page: Session) => void;
      pendingWork?: boolean;
      userRequests?: UserRequest[];
      onRunComplete?: () => Promise<void> | void;
      openRunStream?: typeof openRunEventStream;
    },
  ) {
    this.state = createTranscriptState(config);
    this.snapshotValue = buildAgentSnapshot(this.state, this.isStreaming, this.reconnectError);
  }

  /** Subscribe to any observable state change (for React's useSyncExternalStore). */
  subscribeStore(onChange: () => void) {
    this.storeListeners.add(onChange);
    return () => this.storeListeners.delete(onChange);
  }

  /** Current immutable snapshot; its identity changes only when state changes. */
  getSnapshot(): AgentSnapshot {
    return this.snapshotValue;
  }

  /** Replace the message list (e.g. an optimistic edit/retry) and notify subscribers. */
  setMessages(messages: AgentMessage[], messageEntryIds: string[] = []) {
    this.state.messages = [...messages];
    for (const message of messages)
      confirmPendingMessage(this.state, message, Boolean(this.config.home));
    this.state.messageEntryIds = [...messageEntryIds];
    this.state.loadedEarlier = false;
    this.notify();
  }

  /** Entry ids aligned with the snapshot's messages, for optimistic rollback. */
  getMessageEntryIds(): string[] {
    return [...this.state.messageEntryIds];
  }

  setThinkingLevel(thinkingLevel: ThinkingLevel) {
    this.state.thinkingLevel = thinkingLevel;
    this.notify();
  }

  private notify() {
    this.snapshotValue = buildAgentSnapshot(this.state, this.isStreaming, this.reconnectError);
    for (const onChange of this.storeListeners) onChange();
  }

  private fail(error: unknown) {
    this.state.errorMessage = errorMessage(error);
    this.notify();
  }

  get signal() {
    return this.abortController?.signal;
  }

  async abort() {
    if (this.config.home) {
      try {
        await api.stopHome(this.config.agentId);
        this.state.pendingMessages = [];
        this.notify();
        if (!this.isStreaming) await this.refreshConnection();
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    const runId = this.runId;
    if (!runId) {
      // The admission response is the run id, and it comes back before the
      // model is called. Remember the stop so it is sent the moment that id
      // exists; the server then cancels the run before thinking starts.
      if (this.abortController) {
        this.stopRequested = true;
        return;
      }
      if (!this.state.hasPendingWork) return;
      const controller = this.beginRun();
      try {
        await api.abortSession(this.config.sessionId);
        const connection = await this.readConnection(controller.signal);
        this.applyConnectionSnapshot(connection);
        if (connection.activeRun) {
          this.runId = connection.activeRun.runId;
          this.lastSequence = connection.activeRun.eventCursor;
          await this.watchRun(this.runId, controller.signal);
        }
        await this.notifyRunComplete();
      } catch (error) {
        this.fail(error);
      } finally {
        this.finishObservation();
      }
      return;
    }
    await this.requestAbort(runId);
  }

  detach() {
    this.connectionRefresh++;
    this.detachRequested = true;
    this.abortController?.abort();
  }

  setModel(modelRefId: string, model: Model<Api>, thinkingLevel?: ThinkingLevel) {
    if (this.isStreaming) return;
    this.config.modelRefId = modelRefId;
    this.config.model = model;
    this.state.model = model;
    if (thinkingLevel) this.state.thinkingLevel = thinkingLevel;
    this.notify();
  }

  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
    references?: PromptInput["references"],
  ): Promise<PromptOutcome> {
    if (this.abortController && !this.config.home)
      throw new Error(i18n._("Agent is already processing."));
    const promptInput = normalizePromptInput(input, images);
    if (promptInput && references?.length) promptInput.references = references;
    const pendingMessage: PendingMessage | undefined = promptInput
      ? {
          message: {
            role: "user" as const,
            content: [
              { type: "text" as const, text: promptInput.text },
              ...(promptInput.images ?? []),
            ],
            timestamp: Date.now(),
            references: promptInput.references,
          },
        }
      : undefined;
    if (pendingMessage) {
      this.state.pendingMessages = [...this.state.pendingMessages, pendingMessage];
      this.notify();
    }
    const outcome = await this.submitPrompt(promptInput, pendingMessage);
    if (outcome.status === "rejected" && pendingMessage) {
      this.state.pendingMessages = this.state.pendingMessages.filter(
        (message) => message !== pendingMessage,
      );
      this.notify();
    }
    return outcome;
  }

  private async submitPrompt(
    promptInput: PromptInput | undefined,
    pendingMessage?: PendingMessage,
  ): Promise<PromptOutcome> {
    if (this.config.home && promptInput) {
      try {
        const response = await apiFetch(
          apiUrl(apiRoutes.sendHomeMessage.path, { agentId: this.config.agentId }),
          {
            method: "POST",
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              promptInput,
              modelRefId: this.config.modelRefId,
              thinkingLevel: this.state.thinkingLevel,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          },
        );
        if (!response.ok) {
          const error = await apiError(response, i18n._("Unable to queue this message."));
          this.fail(error);
          return { status: "rejected", error: errorMessage(error) };
        }
        const admission = (await response.json()) as { eventId: string };
        if (pendingMessage) pendingMessage.eventId = admission.eventId;
        for (const message of this.state.messages) confirmPendingMessage(this.state, message, true);
        this.state.errorMessage = undefined;
        this.notify();
        void this.refreshHome();
        return { status: "accepted" };
      } catch (error) {
        this.fail(error);
        return { status: "unknown", error: errorMessage(error) };
      }
    }
    if (this.abortController) throw new Error(i18n._("Agent is already processing."));
    const controller = this.beginRun();
    // Set as soon as a server run exists for this submission, and read by the
    // failure path: after admission the prompt is the server's, whatever the run
    // then does. `rejection` is the opposite -- proof that it never landed.
    let admitted = false;
    let rejection: string | undefined;

    try {
      let response: Response;
      try {
        response = await apiFetch(
          apiUrl(apiRoutes.startAgentRun.path, { id: this.config.agentId }),
          {
            method: "POST",
            body: JSON.stringify({
              sessionId: this.config.sessionId,
              modelRefId: this.config.modelRefId,
              thinkingLevel: this.state.thinkingLevel,
              promptInput,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (controller.signal.aborted) throw error;
        this.markReconnecting(error);
        if (await this.recoverSubmittedRun(controller.signal)) {
          admitted = true;
          await this.notifyRunComplete();
          return { status: "accepted" };
        }
        // The request failed in transit and no run answers for it, so whether
        // the server received it cannot be settled from here: `unknown`.
        throw error;
      }
      if (response.status === 409) {
        this.state.pendingMessages = [];
        const summary = (await response.json().catch(() => undefined)) as
          | Partial<ActiveAgentRunSummary>
          | undefined;
        const activeRunId = response.headers.get("x-agent-run-id") ?? summary?.runId;
        // The session already had a run in flight, so this message was refused.
        // The client still follows the run that holds the session -- but it is
        // somebody else's turn, and this prompt was never sent.
        rejection = i18n._(
          "This conversation already has a run in progress; your message was not sent.",
        );
        if (!activeRunId) throw new Error(rejection);
        const connection = await this.readConnection(controller.signal);
        this.applyConnectionSnapshot(connection);
        if (connection.activeRun && connection.activeRun.runId === activeRunId) {
          this.rememberRun(activeRunId);
          this.lastSequence = connection.activeRun.eventCursor;
          await this.watchRun(activeRunId, controller.signal);
        }
        this.state.errorMessage = rejection;
        await this.notifyRunComplete();
        return { status: "rejected", error: rejection };
      }
      if (!response.ok || !response.body) {
        // The server answered and started nothing, so the message is still the
        // caller's to keep.
        const error = await apiError(
          response,
          i18n._("Agent request failed with {status}", { status: response.status }),
        );
        rejection = errorMessage(error);
        throw error;
      }

      const admittedRun = (await response.json().catch(() => undefined)) as
        | { runId?: string }
        | undefined;
      const runId = response.headers.get("x-agent-run-id") ?? admittedRun?.runId;
      if (!runId) throw new Error(i18n._("Agent response did not identify its server run."));
      this.rememberRun(runId);
      admitted = true;
      this.state.hasPendingWork = false;
      await this.watchRun(runId, controller.signal);
      await this.notifyRunComplete();
      return { status: "accepted" };
    } catch (error) {
      if (!(this.detachRequested && controller.signal.aborted)) {
        this.state.errorMessage = errorMessage(error);
        await this.notifyRunComplete();
      }
      if (admitted) return { status: "accepted" };
      return rejection === undefined
        ? { status: "unknown", error: errorMessage(error) }
        : { status: "rejected", error: rejection };
    } finally {
      this.finishObservation();
    }
  }

  async attachToRun(
    runId: string,
    baseMessages?: AgentMessage[],
    afterSequence = 0,
    progress?: RunProgress,
  ) {
    if (this.abortController) throw new Error(i18n._("Agent is already processing."));
    if (baseMessages) this.state.messages = [...baseMessages];
    const controller = this.beginRun(afterSequence, progress);
    this.runId = runId;

    try {
      await this.watchRun(runId, controller.signal);
      await this.notifyRunComplete();
    } catch (error) {
      if (!(this.detachRequested && controller.signal.aborted)) {
        this.state.errorMessage = errorMessage(error);
        await this.notifyRunComplete();
      }
    } finally {
      this.finishObservation();
    }
  }

  async continue() {
    const lastMessage = this.state.messages[this.state.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      throw new Error(i18n._("Cannot continue from current message state."));
    }
    this.state.replaceNextUserMessage = true;
    return this.prompt([]);
  }

  /** Resume the stored checkpoint without rewinding or resending any message. */
  async resume() {
    return this.prompt([]);
  }

  /** Dismiss the visible run error. */
  dismissError() {
    if (this.state.errorMessage === undefined) return;
    this.state.errorMessage = undefined;
    this.notify();
  }

  private async notifyRunComplete() {
    try {
      await this.config.onRunComplete?.();
    } catch (error) {
      this.fail(error);
    }
  }

  private beginRun(afterSequence = 0, progress?: RunProgress) {
    this.connectionRefresh++;
    const controller = new AbortController();
    this.abortController = controller;
    this.isStreaming = true;
    applyLiveProgress(this.state, progress?.live);
    this.state.errorMessage = progress?.errorMessage;
    // Re-derived by every run: the new one may be on a different model, which is
    // the usual way this condition gets fixed.
    this.state.contextPressure = progress?.contextPressure;
    this.runId = undefined;
    this.lastSequence = afterSequence;
    this.runFinished = false;
    this.detachRequested = false;
    this.stopRequested = false;
    this.reconnectError = undefined;
    this.notify();
    return controller;
  }

  private finishObservation() {
    const refresh = this.refreshWhenIdle && !this.detachRequested;
    this.refreshWhenIdle = false;
    if (!this.config.home) this.state.pendingMessages = [];
    this.isStreaming = false;
    this.state.streamingMessage = undefined;
    this.state.pendingToolCalls = new Set();
    this.state.nestedTools = [];
    this.abortController = undefined;
    this.runId = undefined;
    this.detachRequested = false;
    this.state.replaceNextUserMessage = false;
    this.stopRequested = false;
    this.reconnectError = undefined;
    this.notify();
    if (refresh) void this.refreshHome().catch((error) => this.fail(error));
  }

  /** Record the server run and send a stop that arrived before its id did. */
  private rememberRun(runId: string) {
    this.runId = runId;
    if (this.stopRequested) void this.requestAbort(runId);
  }

  private async requestAbort(runId: string) {
    try {
      await api.abortAgentRun(runId);
    } catch (error) {
      // The run finishing on its own before the abort lands is not an error.
      if (error instanceof ApiError && error.status === 404) return;
      this.fail(error);
    }
  }

  private async watchRun(runId: string, signal: AbortSignal) {
    let retryDelayMs = 0;
    while (true) {
      if (this.runFinished) return;
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (retryDelayMs > 0) await waitForReconnect(retryDelayMs, signal);

      let response: RunEventStream;
      try {
        response = await (this.config.openRunStream ?? openRunEventStream)(
          runId,
          this.lastSequence,
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        this.markReconnecting(error);
        retryDelayMs = nextReconnectDelay(retryDelayMs);
        continue;
      }

      if (response.status === 404) return;
      if (response.status === 409) {
        try {
          const connection = await this.readConnection(signal);
          this.applyConnectionSnapshot(connection);
          if (!connection.activeRun || connection.activeRun.runId !== runId) return;
          this.lastSequence = connection.activeRun.eventCursor;
          retryDelayMs = 0;
        } catch (error) {
          if (signal.aborted) throw error;
          this.markReconnecting(error);
          retryDelayMs = nextReconnectDelay(retryDelayMs);
        }
        continue;
      }
      if (response.status !== 200) throw new Error(i18n._("Invalid agent event cursor."));

      this.clearReconnectError();
      try {
        await this.consumeEvents(response.events);
        if (this.runFinished) return;
        retryDelayMs = 0;
      } catch (error) {
        if (signal.aborted) throw error;
        this.markReconnecting(error);
        retryDelayMs = nextReconnectDelay(retryDelayMs);
      }
      // A clean EOF without run_finished is not terminal authority. Reconnect;
      // a replayed terminal event or a 404 confirms that the server finalized it.
    }
  }

  private async recoverSubmittedRun(signal: AbortSignal) {
    let retryDelayMs = 0;
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (retryDelayMs > 0) await waitForReconnect(retryDelayMs, signal);
      try {
        const connection = await this.readConnection(signal);
        this.applyConnectionSnapshot(connection);
        if (!connection.activeRun) return false;
        this.rememberRun(connection.activeRun.runId);
        this.lastSequence = connection.activeRun.eventCursor;
        await this.watchRun(connection.activeRun.runId, signal);
        return true;
      } catch (error) {
        if (signal.aborted) throw error;
        this.markReconnecting(error);
        retryDelayMs = nextReconnectDelay(retryDelayMs);
      }
    }
  }

  private readConnection(signal: AbortSignal): Promise<SessionConnection> {
    return api.getSessionConnection(this.config.sessionId, signal);
  }

  applyConnectionSnapshot(connection: SessionConnection, preserveHistory = true) {
    this.reconnectError = undefined;
    const merged = applyConnectionToState(this.state, connection, {
      preserveHistory,
      isObserving: Boolean(this.abortController),
      home: Boolean(this.config.home),
    });
    this.config.onConnection?.(merged);
    this.notify();
  }

  async openEntry(entryId: string) {
    if (this.isStreaming) return;
    const page = await api.getSessionHistory(this.config.sessionId, "", entryId);
    applyHistoryEntryPage(this.state, page);
    this.config.onConnection?.({ session: page, activeRun: null });
    this.notify();
  }

  async loadOlder() {
    if (!this.state.olderCursor || this.isStreaming) return;
    const page = await api.getSessionHistory(this.config.sessionId, this.state.olderCursor);
    prependOlderHistoryPage(this.state, page);
    this.config.onHistoryPage?.(page);
    this.notify();
  }

  async refreshHome() {
    if (this.abortController) {
      this.refreshWhenIdle = true;
      return;
    }
    if (this.state.historyOnly) return;
    const refresh = ++this.connectionRefresh;
    const connection = await api.getSessionConnection(this.config.sessionId);
    if (
      refresh !== this.connectionRefresh ||
      this.abortController ||
      this.state.historyOnly ||
      this.detachRequested
    )
      return;
    this.applyConnectionSnapshot(connection);
    if (connection.activeRun && !this.state.historyOnly)
      void this.attachToRun(
        connection.activeRun.runId,
        this.state.messages,
        connection.activeRun.eventCursor,
        connection.runProgress,
      );
  }

  async refreshConnection() {
    this.applyConnectionSnapshot(await api.getSessionConnection(this.config.sessionId), false);
  }

  private async consumeEvents(events: ReadableStream<AgentRunEventEnvelope>) {
    const reader = events.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        this.processEnvelope(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private processEnvelope(envelope: AgentRunEventEnvelope) {
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || !envelope.event) {
      throw new Error(i18n._("Invalid agent event envelope."));
    }
    if (envelope.sequence <= this.lastSequence) return;
    if (envelope.sequence !== this.lastSequence + 1) {
      throw new Error(
        i18n._("Agent event sequence gap: expected {value}, received {sequence}.", {
          value: this.lastSequence + 1,
          sequence: envelope.sequence,
        }),
      );
    }
    this.lastSequence = envelope.sequence;
    const result = applyRunEvent(this.state, envelope.event, Boolean(this.config.home));
    if (result.runFinished) this.runFinished = true;
    this.notify();
  }

  private markReconnecting(error: unknown) {
    this.reconnectError = errorMessage(error);
    this.notify();
  }

  private clearReconnectError() {
    if (this.reconnectError === undefined) return;
    this.reconnectError = undefined;
    this.notify();
  }
}

function nextReconnectDelay(currentMs: number) {
  return currentMs === 0 ? 100 : Math.min(currentMs * 2, 2_000);
}

function waitForReconnect(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
