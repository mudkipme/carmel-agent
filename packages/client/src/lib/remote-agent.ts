import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  ActiveAgentRunSummary,
  AgentRunEvent,
  AgentRunEventEnvelope,
  PromptInput,
  SessionConnection,
} from "@carmel-agent/shared";
import { applyStreamingEvent } from "@carmel-agent/shared";

import { api, ApiError, apiError, apiFetch } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * Immutable view of the agent's observable state, and the only way to read it.
 * Its identity changes only when `notify()` runs, so React's useSyncExternalStore
 * can compare references cheaply, and imperative callers outside render read the
 * same object rather than a second, separately-mutated copy.
 */
export type AgentSnapshot = {
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  isStreaming: boolean;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  errorMessage?: string;
  /** Set when compaction could not keep the session inside its context budget. */
  contextPressure?: ContextPressure;
};

export type ContextPressure = { level: "warning" | "critical"; message: string };

/**
 * What happened to a submission, which is a different question from how the run
 * ended: an admitted run that fails reports its failure as persisted messages,
 * and its prompt must never be handed back to the composer as unsent.
 *
 * `unknown` is the honest answer when the request left this client and no server
 * run can be found for it: it may still have been received, so the caller has to
 * report it without resending or restoring the draft behind the user's back.
 */
export type PromptOutcome =
  | { status: "accepted" }
  | { status: "rejected"; error: string }
  | { status: "unknown"; error: string };

export class RemoteAgent {
  private storeListeners = new Set<() => void>();
  private snapshotValue: AgentSnapshot;
  private abortController?: AbortController;
  private messages: AgentMessage[];
  private streamingMessage?: AgentMessage;
  private pendingToolCalls = new Set<string>();
  private isStreaming = false;
  private model: Model<Api>;
  private thinkingLevel: ThinkingLevel;
  private errorMessage?: string;
  private contextPressure?: ContextPressure;
  private runId?: string;
  private lastSequence = 0;
  private runFinished = false;
  private detachRequested = false;
  private replaceNextUserMessage = false;

  constructor(
    private readonly config: {
      agentId: string;
      sessionId: string;
      modelRefId: string;
      model: Model<Api>;
      thinkingLevel: ThinkingLevel;
      messages: AgentMessage[];
      onRunComplete?: () => Promise<void> | void;
    },
  ) {
    this.messages = [...config.messages];
    this.model = config.model;
    this.thinkingLevel = config.thinkingLevel;
    this.snapshotValue = this.buildSnapshot();
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
  setMessages(messages: AgentMessage[]) {
    this.messages = [...messages];
    this.notify();
  }

  setThinkingLevel(thinkingLevel: ThinkingLevel) {
    this.thinkingLevel = thinkingLevel;
    this.notify();
  }

  private buildSnapshot(): AgentSnapshot {
    return {
      messages: this.messages,
      streamingMessage: this.streamingMessage,
      pendingToolCalls: this.pendingToolCalls,
      isStreaming: this.isStreaming,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      errorMessage: this.errorMessage,
      contextPressure: this.contextPressure,
    };
  }

  private notify() {
    this.snapshotValue = this.buildSnapshot();
    for (const onChange of this.storeListeners) onChange();
  }

  private fail(error: unknown) {
    this.errorMessage = errorMessage(error);
    this.notify();
  }

  get signal() {
    return this.abortController?.signal;
  }

  async abort() {
    const runId = this.runId;
    if (!runId) return;
    try {
      await api.abortAgentRun(runId);
    } catch (error) {
      // The run finishing on its own before the abort lands is not an error.
      if (error instanceof ApiError && error.status === 404) return;
      this.fail(error);
    }
  }

  detach() {
    this.detachRequested = true;
    this.abortController?.abort();
  }

  setModel(modelRefId: string, model: Model<Api>, thinkingLevel?: ThinkingLevel) {
    if (this.isStreaming) return;
    this.config.modelRefId = modelRefId;
    this.config.model = model;
    this.model = model;
    if (thinkingLevel) this.thinkingLevel = thinkingLevel;
    this.notify();
  }

  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<PromptOutcome> {
    if (this.abortController) throw new Error("Agent is already processing.");
    const promptInput = normalizePromptInput(input, images);
    const controller = this.beginRun();
    // Set as soon as a server run exists for this submission, and read by the
    // failure path: after admission the prompt is the server's, whatever the run
    // then does. `rejection` is the opposite -- proof that it never landed.
    let admitted = false;
    let rejection: string | undefined;

    try {
      let response: Response;
      try {
        response = await apiFetch(`/api/agents/${encodeURIComponent(this.config.agentId)}/run`, {
          method: "POST",
          body: JSON.stringify({
            sessionId: this.config.sessionId,
            modelRefId: this.config.modelRefId,
            thinkingLevel: this.thinkingLevel,
            promptInput,
          }),
          signal: controller.signal,
        });
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
        const summary = (await response.json().catch(() => undefined)) as Partial<ActiveAgentRunSummary> | undefined;
        const activeRunId = response.headers.get("x-agent-run-id") ?? summary?.runId;
        // The session already had a run in flight, so this message was refused.
        // The client still follows the run that holds the session -- but it is
        // somebody else's turn, and this prompt was never sent.
        rejection = "This conversation already has a run in progress; your message was not sent.";
        if (!activeRunId) throw new Error(rejection);
        const connection = await this.readConnection(controller.signal);
        this.applyConnectionSnapshot(connection);
        if (connection.activeRun && connection.activeRun.runId === activeRunId) {
          this.runId = activeRunId;
          this.lastSequence = connection.activeRun.eventCursor;
          await this.watchRun(activeRunId, controller.signal);
        }
        this.errorMessage = rejection;
        await this.notifyRunComplete();
        return { status: "rejected", error: rejection };
      }
      if (!response.ok || !response.body) {
        // The server answered and started nothing, so the message is still the
        // caller's to keep.
        const error = await apiError(response, `Agent request failed with ${response.status}`);
        rejection = errorMessage(error);
        throw error;
      }

      const runId = response.headers.get("x-agent-run-id");
      if (!runId) throw new Error("Agent response did not identify its server run.");
      this.runId = runId;
      admitted = true;
      await this.consumeAcceptedResponse(response.body, controller.signal);
      await this.watchRun(runId, controller.signal);
      await this.notifyRunComplete();
      return { status: "accepted" };
    } catch (error) {
      if (!(this.detachRequested && controller.signal.aborted)) {
        this.errorMessage = errorMessage(error);
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

  async attachToRun(runId: string, baseMessages?: AgentMessage[], afterSequence = 0) {
    if (this.abortController) throw new Error("Agent is already processing.");
    if (baseMessages) this.messages = [...baseMessages];
    const controller = this.beginRun(afterSequence);
    this.runId = runId;

    try {
      await this.watchRun(runId, controller.signal);
      await this.notifyRunComplete();
    } catch (error) {
      if (!(this.detachRequested && controller.signal.aborted)) {
        this.errorMessage = errorMessage(error);
        await this.notifyRunComplete();
      }
    } finally {
      this.finishObservation();
    }
  }

  async continue() {
    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "user") {
      throw new Error("Cannot continue from current message state.");
    }
    this.replaceNextUserMessage = true;
    return this.prompt([]);
  }

  /** Dismiss the visible error. Reconnection failures re-report themselves. */
  dismissError() {
    if (this.errorMessage === undefined) return;
    this.errorMessage = undefined;
    this.notify();
  }

  private async notifyRunComplete() {
    try {
      await this.config.onRunComplete?.();
    } catch (error) {
      this.fail(error);
    }
  }

  private beginRun(afterSequence = 0) {
    const controller = new AbortController();
    this.abortController = controller;
    this.isStreaming = true;
    this.streamingMessage = undefined;
    this.errorMessage = undefined;
    // Re-derived by every run: the new one may be on a different model, which is
    // the usual way this condition gets fixed.
    this.contextPressure = undefined;
    this.runId = undefined;
    this.lastSequence = afterSequence;
    this.runFinished = false;
    this.detachRequested = false;
    this.notify();
    return controller;
  }

  private finishObservation() {
    this.isStreaming = false;
    this.streamingMessage = undefined;
    this.pendingToolCalls = new Set();
    this.abortController = undefined;
    this.runId = undefined;
    this.detachRequested = false;
    this.replaceNextUserMessage = false;
    this.notify();
  }

  private async consumeAcceptedResponse(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    try {
      await this.consumeEvents(body);
    } catch (error) {
      if (signal.aborted) throw error;
      this.markReconnecting(error);
    }
  }

  private async watchRun(runId: string, signal: AbortSignal) {
    let retryDelayMs = 0;
    while (true) {
      if (this.runFinished) return;
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (retryDelayMs > 0) await waitForReconnect(retryDelayMs, signal);

      let response: Response;
      try {
        const query = new URLSearchParams({ after: String(this.lastSequence) });
        response = await apiFetch(`/api/agent-runs/${encodeURIComponent(runId)}/events?${query}`, { signal });
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
      if (!response.ok || !response.body) {
        if (response.status === 400) throw await apiError(response, "Invalid agent event cursor.");
        this.markReconnecting(await apiError(response, `Agent event stream failed with ${response.status}`));
        retryDelayMs = nextReconnectDelay(retryDelayMs);
        continue;
      }

      this.clearReconnectError();
      try {
        await this.consumeEvents(response.body);
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
        this.runId = connection.activeRun.runId;
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

  private applyConnectionSnapshot(connection: SessionConnection) {
    this.messages = [...connection.session.messages];
    this.thinkingLevel = connection.session.thinkingLevel;
    this.streamingMessage = undefined;
    this.pendingToolCalls = new Set();
    this.notify();
  }

  private async consumeEvents(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.processEnvelope(JSON.parse(line) as AgentRunEventEnvelope);
      }
    }
    if (buffer.trim()) this.processEnvelope(JSON.parse(buffer) as AgentRunEventEnvelope);
  }

  private processEnvelope(envelope: AgentRunEventEnvelope) {
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 || !envelope.event) {
      throw new Error("Invalid agent event envelope.");
    }
    if (envelope.sequence <= this.lastSequence) return;
    if (envelope.sequence !== this.lastSequence + 1) {
      throw new Error(`Agent event sequence gap: expected ${this.lastSequence + 1}, received ${envelope.sequence}.`);
    }
    this.lastSequence = envelope.sequence;
    this.processEvent(envelope.event);
  }

  private markReconnecting(error: unknown) {
    this.errorMessage = `${RECONNECTING_PREFIX} ${errorMessage(error)}`;
    this.notify();
  }

  private clearReconnectError() {
    if (!this.errorMessage?.startsWith(RECONNECTING_PREFIX)) return;
    this.errorMessage = undefined;
    this.notify();
  }

  private processEvent(event: AgentRunEvent) {
    switch (event.type) {
      case "message_start":
      case "message_delta":
      case "message_part":
        // Text and thinking arrive as deltas, so the streaming message is
        // rebuilt here rather than replaced wholesale.
        this.streamingMessage = applyStreamingEvent(this.streamingMessage, event);
        break;
      case "message_end":
        this.streamingMessage = undefined;
        if (this.replaceNextUserMessage && event.message.role === "user") {
          this.messages = [...this.messages.slice(0, -1), event.message];
          this.replaceNextUserMessage = false;
        } else {
          this.messages = [...this.messages, event.message];
        }
        break;
      case "tool_execution_start": {
        const pendingToolCalls = new Set(this.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this.pendingToolCalls = pendingToolCalls;
        break;
      }
      case "tool_execution_end": {
        const pendingToolCalls = new Set(this.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this.pendingToolCalls = pendingToolCalls;
        break;
      }
      case "turn_end":
        if (event.errorMessage) this.errorMessage = event.errorMessage;
        break;
      case "run_recovered":
        // The failing turn_end already set an error the user can see. It was
        // true when it was sent and is not any more, so clearing it is part of
        // reporting the recovery honestly.
        this.errorMessage = undefined;
        this.contextPressure = { level: "warning", message: event.message };
        break;
      case "context_pressure":
        // Survives `run_finished`: the condition it reports is a property of the
        // session, so clearing it when the run ends would hide it exactly when
        // the user is reading the result.
        this.contextPressure = { level: event.level, message: event.message };
        break;
      case "agent_end":
        // AgentHarness has stopped producing messages, but server persistence and
        // title generation still follow, so this is not terminal authority.
        this.streamingMessage = undefined;
        break;
      case "run_finished":
        this.runFinished = true;
        this.streamingMessage = undefined;
        this.pendingToolCalls = new Set();
        // The server's verdict on the whole run. A failed turn has usually said
        // so already, and its wording is the more specific; this covers what no
        // turn reports -- a result that could not be saved, or a shutdown.
        if ((event.result.outcome === "failed" || event.result.outcome === "interrupted") && !this.errorMessage) {
          this.errorMessage = event.result.detail ?? "This run did not finish successfully.";
        }
        break;
    }
    this.notify();
  }
}

const RECONNECTING_PREFIX = "Connection lost; reconnecting…";

/** Whether a snapshot error is the transient reconnect state rather than a failure. */
export function isReconnectingMessage(message: string) {
  return message.startsWith(RECONNECTING_PREFIX);
}

function normalizePromptInput(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): PromptInput | undefined {
  if (typeof input === "string") return { text: input, images: images?.length ? images : undefined };
  const messages = Array.isArray(input) ? input : [input];
  const textParts: string[] = [];
  const imageParts: ImageContent[] = [];

  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "text") textParts.push(part.text);
      if (part.type === "image") imageParts.push(part);
    }
  }

  if (textParts.length === 0 && imageParts.length === 0) return undefined;
  return {
    text: textParts.join("\n\n"),
    images: imageParts.length > 0 ? imageParts : undefined,
  };
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
