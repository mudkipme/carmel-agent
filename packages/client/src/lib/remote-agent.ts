import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { PromptInput } from "@carmel-agent/shared";

type MutableAgentState = Omit<
  AgentState,
  "tools" | "messages" | "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

// Immutable view of the agent's observable state. Its identity changes only when
// `notify()` runs, so React's useSyncExternalStore can compare references cheaply.
export type AgentSnapshot = {
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  isStreaming: boolean;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  errorMessage?: string;
};

export class RemoteAgent {
  private storeListeners = new Set<() => void>();
  private snapshotValue: AgentSnapshot;
  private abortController?: AbortController;
  private tools: AgentTool[] = [];
  private messages: AgentMessage[];
  private sawAgentEnd = false;
  private runId?: string;
  private detachRequested = false;

  readonly state: MutableAgentState;

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
    this.state = {
      systemPrompt: "",
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      get tools() {
        return [];
      },
      set tools(tools: AgentTool[]) {
        void tools;
      },
      get messages() {
        return [];
      },
      set messages(_messages: AgentMessage[]) {},
      isStreaming: false,
      streamingMessage: undefined,
      pendingToolCalls: new Set(),
      errorMessage: undefined,
    } as MutableAgentState;

    Object.defineProperty(this.state, "tools", {
      get: () => this.tools,
      set: (tools: AgentTool[]) => {
        this.tools = [...tools];
      },
    });
    Object.defineProperty(this.state, "messages", {
      get: () => this.messages,
      set: (messages: AgentMessage[]) => {
        this.messages = [...messages];
        this.notify();
      },
    });

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
    this.state.thinkingLevel = thinkingLevel;
    this.notify();
  }

  private buildSnapshot(): AgentSnapshot {
    return {
      messages: this.messages,
      streamingMessage: this.state.streamingMessage,
      pendingToolCalls: this.state.pendingToolCalls,
      isStreaming: this.state.isStreaming,
      model: this.state.model,
      thinkingLevel: this.state.thinkingLevel,
      errorMessage: this.state.errorMessage,
    };
  }

  private notify() {
    this.snapshotValue = this.buildSnapshot();
    for (const onChange of this.storeListeners) onChange();
  }

  get signal() {
    return this.abortController?.signal;
  }

  abort() {
    const runId = this.runId;
    if (runId) {
      void fetch(`/api/agent-runs/${encodeURIComponent(runId)}/abort`, {
        method: "POST",
        credentials: "include",
      }).catch(() => undefined);
    }
    this.abortController?.abort();
  }

  detach() {
    this.detachRequested = true;
    this.abortController?.abort();
  }

  setModel(modelRefId: string, model: Model<Api>, thinkingLevel?: ThinkingLevel) {
    if (this.state.isStreaming) return;
    this.config.modelRefId = modelRefId;
    this.config.model = model;
    this.state.model = model;
    if (thinkingLevel) this.state.thinkingLevel = thinkingLevel;
    this.notify();
  }

  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
    if (this.abortController) throw new Error("Agent is already processing.");
    const promptInput = normalizePromptInput(input, images);
    const controller = this.beginRun();

    try {
      const response = await fetch(`/api/agents/${this.config.agentId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: this.config.sessionId,
          modelRefId: this.config.modelRefId,
          thinkingLevel: this.state.thinkingLevel,
          promptInput,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const activeRunId = response.status === 409 ? response.headers.get("x-agent-run-id") : undefined;
        if (activeRunId) {
          this.runId = activeRunId;
          await this.consumeActiveRun(activeRunId, controller.signal);
          await this.config.onRunComplete?.();
          return;
        }
        throw new Error((await response.text()) || `Agent request failed with ${response.status}`);
      }
      this.runId = response.headers.get("x-agent-run-id") ?? undefined;
      await this.consumeEvents(response.body);
      if (!this.sawAgentEnd) {
        this.processEvent({ type: "agent_end", messages: this.messages });
      }
      await this.config.onRunComplete?.();
    } catch (error) {
      if (!(this.detachRequested && controller.signal.aborted)) {
        this.handleFailure(error, controller.signal.aborted);
      }
    } finally {
      this.state.isStreaming = false;
      this.state.streamingMessage = undefined;
      this.state.pendingToolCalls = new Set();
      this.abortController = undefined;
      this.runId = undefined;
      this.detachRequested = false;
      this.notify();
    }
  }

  async attachToRun(runId: string, baseMessages?: AgentMessage[]) {
    if (this.abortController) throw new Error("Agent is already processing.");
    if (baseMessages) this.messages = [...baseMessages];
    const controller = this.beginRun();
    this.runId = runId;

    try {
      await this.consumeActiveRun(runId, controller.signal);
      await this.config.onRunComplete?.();
    } catch (error) {
      if (!(this.detachRequested && controller.signal.aborted)) {
        this.state.errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.state.isStreaming = false;
      this.state.streamingMessage = undefined;
      this.state.pendingToolCalls = new Set();
      this.abortController = undefined;
      this.runId = undefined;
      this.detachRequested = false;
      this.notify();
    }
  }

  async continue() {
    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role === "assistant") {
      throw new Error("Cannot continue from current message state.");
    }
    await this.prompt([]);
  }

  private beginRun() {
    const controller = new AbortController();
    this.abortController = controller;
    this.state.isStreaming = true;
    this.state.streamingMessage = undefined;
    this.state.errorMessage = undefined;
    this.sawAgentEnd = false;
    this.runId = undefined;
    this.detachRequested = false;
    this.notify();
    return controller;
  }

  private async consumeActiveRun(runId: string, signal: AbortSignal) {
    const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/events`, {
      credentials: "include",
      signal,
    });
    if (response.status === 404) {
      return;
    }
    if (!response.ok || !response.body) {
      throw new Error((await response.text()) || `Agent event stream failed with ${response.status}`);
    }
    await this.consumeEvents(response.body);
    if (!this.sawAgentEnd) {
      this.processEvent({ type: "agent_end", messages: this.messages });
    }
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
        if (line.trim()) {
          this.processEvent(JSON.parse(line) as AgentEvent);
        }
      }
    }
    if (buffer.trim()) {
      this.processEvent(JSON.parse(buffer) as AgentEvent);
    }
  }

  private processEvent(event: AgentEvent) {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this.state.streamingMessage = event.message;
        break;
      case "message_end":
        this.state.streamingMessage = undefined;
        this.messages = [...this.messages, event.message];
        break;
      case "tool_execution_start": {
        const pendingToolCalls = new Set(this.state.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this.state.pendingToolCalls = pendingToolCalls;
        break;
      }
      case "tool_execution_end": {
        const pendingToolCalls = new Set(this.state.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this.state.pendingToolCalls = pendingToolCalls;
        break;
      }
      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this.state.errorMessage = event.message.errorMessage;
        }
        break;
      case "agent_end":
        // A single run can emit multiple agent_end events: pi auto-retries
        // retryable failures (e.g. a 429) by ending the agent loop and starting
        // a new one, so an agent_end here may be followed by auto_retry_start and
        // another loop. The run is only truly finished when the event stream
        // closes, so isStreaming is cleared in the stream-consumer finally blocks
        // (prompt/attachToRun), not here — otherwise the send button would flip
        // back from "stop" to "send" while a retry is still in flight.
        this.sawAgentEnd = true;
        this.state.streamingMessage = undefined;
        break;
    }
    this.notify();
  }

  private handleFailure(error: unknown, aborted: boolean) {
    const message: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: this.state.model.api,
      provider: this.state.model.provider,
      model: this.state.model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    this.messages = [...this.messages, message];
    this.state.errorMessage = message.errorMessage;
    this.processEvent({ type: "agent_end", messages: [message] });
  }
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
