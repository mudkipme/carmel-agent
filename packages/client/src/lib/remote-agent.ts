import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  AgentToolResult,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  ClientToolCallEvent,
  ClientToolResultPayload,
  PromptInput,
} from "@carmel-agent/shared";

type Listener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
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

export class RemoteAgent {
  private listeners = new Set<Listener>();
  private abortController?: AbortController;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle?: () => void;
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
      },
    });
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  waitForIdle() {
    return this.idlePromise;
  }

  reset() {
    this.messages = [];
    this.state.isStreaming = false;
    this.state.streamingMessage = undefined;
    this.state.pendingToolCalls = new Set();
    this.state.errorMessage = undefined;
  }

  setModel(modelRefId: string, model: Model<Api>, thinkingLevel?: ThinkingLevel) {
    if (this.state.isStreaming) return;
    this.config.modelRefId = modelRefId;
    this.config.model = model;
    this.state.model = model;
    if (thinkingLevel) this.state.thinkingLevel = thinkingLevel;
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
      await this.consumeEvents(response.body, controller.signal);
      if (!this.sawAgentEnd) {
        await this.processEvent({ type: "agent_end", messages: this.messages }, controller.signal);
      }
      await this.config.onRunComplete?.();
    } catch (error) {
      if (!(this.detachRequested && controller.signal.aborted)) {
        await this.handleFailure(error, controller.signal.aborted);
      }
    } finally {
      this.state.isStreaming = false;
      this.state.streamingMessage = undefined;
      this.state.pendingToolCalls = new Set();
      this.abortController = undefined;
      this.runId = undefined;
      this.detachRequested = false;
      this.resolveIdle?.();
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
      this.resolveIdle?.();
    }
  }

  async continue() {
    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.role === "assistant") {
      throw new Error("Cannot continue from current message state.");
    }
    await this.prompt([]);
  }

  steer() {}
  followUp() {}
  clearSteeringQueue() {}
  clearFollowUpQueue() {}
  clearAllQueues() {}
  hasQueuedMessages() {
    return false;
  }

  private beginRun() {
    const controller = new AbortController();
    this.abortController = controller;
    this.idlePromise = new Promise((resolve) => {
      this.resolveIdle = resolve;
    });
    this.state.isStreaming = true;
    this.state.streamingMessage = undefined;
    this.state.errorMessage = undefined;
    this.sawAgentEnd = false;
    this.runId = undefined;
    this.detachRequested = false;
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
    await this.consumeEvents(response.body, signal);
    if (!this.sawAgentEnd) {
      await this.processEvent({ type: "agent_end", messages: this.messages }, signal);
    }
  }

  private async consumeEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
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
          await this.processEvent(JSON.parse(line) as AgentEvent | ClientToolCallEvent, signal);
        }
      }
    }
    if (buffer.trim()) {
      await this.processEvent(JSON.parse(buffer) as AgentEvent | ClientToolCallEvent, signal);
    }
  }

  private async processEvent(event: AgentEvent | ClientToolCallEvent, signal: AbortSignal) {
    if (isClientToolCallEvent(event)) {
      await this.executeClientToolCall(event, signal);
      return;
    }

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
        this.sawAgentEnd = true;
        this.state.isStreaming = false;
        this.state.streamingMessage = undefined;
        break;
    }
    for (const listener of this.listeners) await listener(event, signal);
  }

  private async executeClientToolCall(event: ClientToolCallEvent, signal: AbortSignal) {
    const tool = this.tools.find((candidate) => candidate.name === event.toolName);
    if (!tool) {
      await this.postClientToolResult(event, { error: `Browser tool "${event.toolName}" is not available.` }, signal);
      return;
    }

    try {
      const result = await tool.execute(event.toolCallId, event.args as never, signal);
      await this.postClientToolResult(event, { result: normalizeToolResult(result) }, signal);
    } catch (error) {
      await this.postClientToolResult(
        event,
        { error: error instanceof Error ? error.message : String(error) },
        signal,
      );
    }
  }

  private async postClientToolResult(
    event: ClientToolCallEvent,
    payload: Pick<ClientToolResultPayload, "result" | "error">,
    signal: AbortSignal,
  ) {
    const response = await fetch("/api/client-tool-results", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        runId: event.runId,
        toolCallId: event.toolCallId,
        nonce: event.nonce,
        ...payload,
      } satisfies ClientToolResultPayload),
      signal,
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Client tool result failed with ${response.status}`);
    }
  }

  private async handleFailure(error: unknown, aborted: boolean) {
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
    await this.processEvent({ type: "agent_end", messages: [message] }, new AbortController().signal);
  }
}

function isClientToolCallEvent(event: AgentEvent | ClientToolCallEvent): event is ClientToolCallEvent {
  return event.type === "client_tool_call";
}

function normalizeToolResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
  return {
    content: result.content,
    details: result.details,
    terminate: result.terminate === true ? true : undefined,
  };
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
