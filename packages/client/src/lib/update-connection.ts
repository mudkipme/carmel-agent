import {
  stateTopics,
  type AgentRunEventEnvelope,
  type StateTopic,
  type UpdateClientMessage,
  type UpdateServerMessage,
} from "@carmel-agent/shared";

export type RunEventStream =
  | { status: 200; events: ReadableStream<AgentRunEventEnvelope> }
  | { status: 400 | 404 | 409 };

type RunReader = {
  open: (status: 200 | 400 | 404 | 409) => void;
  enqueue: (message: Extract<UpdateServerMessage, { type: "run_event" }>) => void;
  close: () => void;
  fail: (error: Error) => void;
  request: UpdateClientMessage;
};

export class UpdateConnection {
  private socket?: WebSocket;
  private ready = false;
  private revision = 0;
  private references = 0;
  private nextId = 0;
  private retryDelay = 250;
  private retry?: ReturnType<typeof setTimeout>;
  private listeners = new Map<() => void, readonly StateTopic[]>();
  private readers = new Map<string, RunReader>();

  constructor(
    private readonly createSocket = () => {
      const url = new URL("/api/updates", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url);
    },
  ) {}

  subscribe(topics: readonly StateTopic[], listener: () => void) {
    this.listeners.set(listener, topics);
    const release = this.retain();
    if (this.ready) listener();
    return () => {
      this.listeners.delete(listener);
      release();
    };
  }

  refreshState(topics: readonly StateTopic[]) {
    this.invalidate(topics);
  }

  openRunStream(runId: string, after: number, signal: AbortSignal): Promise<RunEventStream> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const id = String(++this.nextId);
      let controller: ReadableStreamDefaultController<AgentRunEventEnvelope>;
      let settled = false;
      const body = new ReadableStream<AgentRunEventEnvelope>({
        start(value) {
          controller = value;
        },
        cancel: () => cleanup(),
      });
      const cleanup = () => {
        if (!this.readers.delete(id)) return;
        signal.removeEventListener("abort", abort);
        this.send({ type: "unwatch_run", id });
        release();
      };
      const abort = () => {
        reject(signal.reason);
        controller.error(signal.reason);
        cleanup();
      };
      const release = this.retain();
      const reader: RunReader = {
        request: { type: "watch_run", id, runId, after },
        open: (status) => {
          settled = true;
          if (status === 200) resolve({ status, events: body });
          else {
            controller.close();
            resolve({ status });
            cleanup();
          }
        },
        enqueue: (message) => controller.enqueue(message.envelope),
        close: () => {
          controller.close();
          cleanup();
        },
        fail: (error) => {
          if (!settled) reject(error);
          controller.error(error);
          cleanup();
        },
      };
      this.readers.set(id, reader);
      signal.addEventListener("abort", abort, { once: true });
      if (this.ready) this.send(reader.request);
      if (signal.aborted) abort();
    });
  }

  private retain() {
    this.references++;
    if (!this.socket && !this.retry) this.connect();
    return () => {
      this.references--;
      if (this.references) return;
      clearTimeout(this.retry);
      this.retry = undefined;
      const socket = this.socket;
      this.socket = undefined;
      this.ready = false;
      socket?.close();
    };
  }

  private send(message: UpdateClientMessage) {
    if (this.ready && this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private connect() {
    let socket: WebSocket;
    try {
      socket = this.createSocket();
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(String(event.data)) as UpdateServerMessage;
        if (message.type === "ready") {
          this.ready = true;
          this.revision = message.revision;
          this.retryDelay = 250;
          for (const reader of this.readers.values()) this.send(reader.request);
          this.invalidate(stateTopics);
        } else if (message.type === "state_changed") {
          if (message.revision <= this.revision) return;
          const topics = message.revision === this.revision + 1 ? message.topics : stateTopics;
          this.revision = message.revision;
          this.invalidate(topics);
        } else {
          const reader = this.readers.get(message.id);
          if (!reader) return;
          if (message.type === "run_open") reader.open(message.status);
          else if (message.type === "run_event") reader.enqueue(message);
          else if (message.type === "run_close") reader.close();
        }
      } catch {
        socket.close(1002, "Invalid update message");
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      for (const reader of this.readers.values()) reader.fail(new Error("Update connection lost"));
      this.invalidate(stateTopics);
      this.scheduleReconnect();
    };
  }

  private invalidate(topics: readonly StateTopic[]) {
    if (topics.includes("workspace")) topics = stateTopics;
    for (const [listener, watched] of this.listeners) {
      if (watched.some((topic) => topics.includes(topic))) listener();
    }
  }

  private scheduleReconnect() {
    if (!this.references || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(10_000, this.retryDelay * 2);
  }
}

export const updateConnection = new UpdateConnection();

export const openRunEventStream = (runId: string, after: number, signal: AbortSignal) =>
  updateConnection.openRunStream(runId, after, signal);
