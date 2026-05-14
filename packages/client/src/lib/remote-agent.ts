import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { PromptInput } from "@carmel-agent/shared";

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

  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) {
    if (this.abortController) throw new Error("Agent is already processing.");
    const promptInput = normalizePromptInput(input, images);
    this.abortController = new AbortController();
    this.idlePromise = new Promise((resolve) => {
      this.resolveIdle = resolve;
    });
    this.state.isStreaming = true;
    this.state.streamingMessage = undefined;
    this.state.errorMessage = undefined;

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
        signal: this.abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error((await response.text()) || `Agent request failed with ${response.status}`);
      }
      await this.consumeEvents(response.body, this.abortController.signal);
      await this.config.onRunComplete?.();
    } catch (error) {
      await this.handleFailure(error, this.abortController.signal.aborted);
    } finally {
      this.state.isStreaming = false;
      this.state.streamingMessage = undefined;
      this.state.pendingToolCalls = new Set();
      this.abortController = undefined;
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
        if (line.trim()) await this.processEvent(JSON.parse(line) as AgentEvent, signal);
      }
    }
    if (buffer.trim()) await this.processEvent(JSON.parse(buffer) as AgentEvent, signal);
  }

  private async processEvent(event: AgentEvent, signal: AbortSignal) {
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
        this.state.isStreaming = false;
        this.state.streamingMessage = undefined;
        break;
    }
    for (const listener of this.listeners) await listener(event, signal);
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
