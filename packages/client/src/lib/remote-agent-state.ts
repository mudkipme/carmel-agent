import { i18n } from "@lingui/core";
import type {
  AgentMessage,
  Api,
  ImageContent,
  Model,
  ThinkingLevel,
} from "@carmel-agent/shared/pi";
import {
  applyRunProgress,
  type AgentRunEvent,
  type NestedToolSlot,
  type PromptInput,
  type ReferenceMessage,
  type RunProgress,
  type Session,
  type SessionConnection,
  type UserRequest,
} from "@carmel-agent/shared";

export type AgentConnection = { status: "connected" } | { status: "reconnecting"; message: string };

/**
 * Immutable view of the agent's observable state, and the only way to read it.
 * Its identity changes only when `notify()` runs, so React's useSyncExternalStore
 * can compare references cheaply, and imperative callers outside render read the
 * same object rather than a second, separately-mutated copy.
 */
export type AgentSnapshot = {
  messages: AgentMessage[];
  olderCursor?: string;
  loadedEarlier?: boolean;
  historyOnly?: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  nestedTools?: readonly NestedToolSlot[];
  isStreaming: boolean;
  hasPendingWork: boolean;
  connection: AgentConnection;
  userRequests: UserRequest[];
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  errorMessage?: string;
  /** Set when compaction could not keep the session inside its context budget. */
  contextPressure?: ContextPressure;
};

export type ContextPressure = NonNullable<RunProgress["contextPressure"]>;

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

export type PendingMessage = { message: ReferenceMessage; eventId?: string };

export type TranscriptState = {
  messages: AgentMessage[];
  pendingMessages: PendingMessage[];
  messageEntryIds: string[];
  loadedEarlier: boolean;
  olderCursor?: string;
  historyOnly: boolean;
  live?: RunProgress["live"];
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  nestedTools: readonly NestedToolSlot[];
  hasPendingWork: boolean;
  userRequests: UserRequest[];
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  errorMessage?: string;
  contextPressure?: ContextPressure;
  replaceNextUserMessage: boolean;
};

export function createTranscriptState(initial: {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  messageEntryIds?: string[];
  olderCursor?: string;
  pendingWork?: boolean;
  userRequests?: UserRequest[];
}): TranscriptState {
  return {
    messages: [...initial.messages],
    pendingMessages: [],
    messageEntryIds: [...(initial.messageEntryIds ?? [])],
    loadedEarlier: false,
    olderCursor: initial.olderCursor,
    historyOnly: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set(),
    nestedTools: [],
    hasPendingWork: initial.pendingWork ?? false,
    userRequests: initial.userRequests ?? [],
    model: initial.model,
    thinkingLevel: initial.thinkingLevel,
    errorMessage: undefined,
    contextPressure: undefined,
    replaceNextUserMessage: false,
  };
}

export function buildAgentSnapshot(
  state: TranscriptState,
  isStreaming: boolean,
  reconnectError?: string,
): AgentSnapshot {
  return {
    messages: state.pendingMessages.length
      ? [...state.messages, ...state.pendingMessages.map((pending) => pending.message)]
      : state.messages,
    olderCursor: state.olderCursor,
    loadedEarlier: state.loadedEarlier,
    historyOnly: state.historyOnly,
    streamingMessage: state.streamingMessage,
    pendingToolCalls: state.pendingToolCalls,
    nestedTools: state.nestedTools,
    isStreaming,
    hasPendingWork: state.hasPendingWork,
    connection:
      reconnectError === undefined
        ? { status: "connected" }
        : { status: "reconnecting", message: reconnectError },
    userRequests: state.userRequests,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    errorMessage: state.errorMessage,
    contextPressure: state.contextPressure,
  };
}

export function applyLiveProgress(state: TranscriptState, live: RunProgress["live"]) {
  state.live = live;
  state.streamingMessage = live?.generation?.message as AgentMessage | undefined;
  state.pendingToolCalls = new Set(
    live?.tools?.filter((call) => call.status !== "done").map((call) => call.callId),
  );
  state.nestedTools = live?.nestedTools ?? [];
}

export function confirmPendingMessage(
  state: TranscriptState,
  message: AgentMessage,
  home: boolean,
) {
  if (message.role !== "user") return;
  const eventId = (message as AgentMessage & { homeEventId?: string }).homeEventId;
  const index = home
    ? state.pendingMessages.findIndex((pending) => eventId && pending.eventId === eventId)
    : 0;
  if (index >= 0) state.pendingMessages = state.pendingMessages.filter((_, item) => item !== index);
}

export function applyConnectionToState(
  state: TranscriptState,
  connection: SessionConnection,
  options: { preserveHistory: boolean; isObserving: boolean; home: boolean },
): SessionConnection {
  const recent = connection.session;
  const overlap =
    options.preserveHistory && state.loadedEarlier && !state.historyOnly
      ? state.messageEntryIds.indexOf(recent.messageEntryIds[0] ?? "")
      : -1;
  state.historyOnly = false;
  if (overlap >= 0) {
    const messages = [...state.messages.slice(0, overlap), ...recent.messages];
    const messageEntryIds = [...state.messageEntryIds.slice(0, overlap), ...recent.messageEntryIds];
    state.historyOnly = messages.length > 500;
    connection = {
      ...connection,
      session: {
        ...recent,
        messages: messages.slice(0, 500),
        messageEntryIds: messageEntryIds.slice(0, 500),
        olderCursor: state.olderCursor,
      },
    };
  } else state.loadedEarlier = false;
  const conversationChanged =
    connection.session.messageEntryIds.at(-1) !== state.messageEntryIds.at(-1);
  state.messages = [...connection.session.messages];
  for (const message of state.messages) confirmPendingMessage(state, message, options.home);
  state.messageEntryIds = [...connection.session.messageEntryIds];
  state.olderCursor = connection.session.olderCursor;
  state.hasPendingWork = connection.pendingWork ?? false;
  state.userRequests = connection.userRequests ?? [];
  state.thinkingLevel = connection.session.thinkingLevel;
  applyLiveProgress(state, connection.runProgress?.live);
  if (connection.runProgress) {
    state.errorMessage = connection.runProgress.errorMessage;
    state.contextPressure = connection.runProgress.contextPressure;
  } else if (conversationChanged && !options.isObserving) {
    const last = state.messages.at(-1);
    state.errorMessage =
      last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage : undefined;
  }
  return connection;
}

export function applyHistoryEntryPage(state: TranscriptState, page: Session) {
  state.messages = page.messages;
  state.messageEntryIds = page.messageEntryIds;
  state.loadedEarlier = false;
  state.olderCursor = page.olderCursor;
  state.historyOnly = true;
}

export function prependOlderHistoryPage(state: TranscriptState, page: Session) {
  const combined = [...page.messages, ...state.messages];
  state.historyOnly = state.historyOnly || combined.length > 500;
  state.messages = combined.slice(0, 500);
  state.messageEntryIds = [...page.messageEntryIds, ...state.messageEntryIds].slice(0, 500);
  state.loadedEarlier = true;
  state.olderCursor = page.olderCursor;
}

export function applyRunEvent(
  state: TranscriptState,
  event: AgentRunEvent,
  home: boolean,
): { runFinished: boolean } {
  const progress = applyRunProgress(
    {
      live: state.live,
      errorMessage: state.errorMessage,
      contextPressure: state.contextPressure,
    },
    event,
  );
  if (event.type === "live_update" || event.type === "run_finished")
    applyLiveProgress(state, progress.live);
  let runFinished = false;
  switch (event.type) {
    case "live_update":
      break;
    case "message_end":
      state.streamingMessage = undefined;
      confirmPendingMessage(state, event.message, home);
      if (state.replaceNextUserMessage && event.message.role === "user") {
        state.messages = [...state.messages.slice(0, -1), event.message];
        state.replaceNextUserMessage = false;
      } else {
        state.messages = [...state.messages, event.message];
      }
      break;
    case "turn_end":
      if (event.errorMessage) state.errorMessage = event.errorMessage;
      break;
    case "run_recovered":
      // The failing turn_end already set an error the user can see. It was
      // true when it was sent and is not any more, so clearing it is part of
      // reporting the recovery honestly.
      state.errorMessage = undefined;
      state.contextPressure = { level: "warning", message: event.message };
      break;
    case "context_pressure":
      // Survives `run_finished`: the condition it reports is a property of the
      // session, so clearing it when the run ends would hide it exactly when
      // the user is reading the result.
      state.contextPressure = { level: event.level, message: event.message };
      break;
    case "agent_end":
      // The native conversation has stopped producing messages, but server persistence and
      // title generation still follow, so this is not terminal authority.
      state.streamingMessage = undefined;
      break;
    case "run_finished":
      runFinished = true;
      state.streamingMessage = undefined;
      state.pendingToolCalls = new Set();
      // The server's verdict on the whole run. A failed turn has usually said
      // so already, and its wording is the more specific; this covers what no
      // turn reports -- a result that could not be saved, or a shutdown.
      if (
        (event.result.outcome === "failed" || event.result.outcome === "interrupted") &&
        !state.errorMessage
      ) {
        state.errorMessage = event.result.detail ?? i18n._("This run did not finish successfully.");
      }
      break;
  }
  return { runFinished };
}

export function normalizePromptInput(
  input: string | AgentMessage | AgentMessage[],
  images?: ImageContent[],
): PromptInput | undefined {
  if (typeof input === "string")
    return { text: input, images: images?.length ? images : undefined };
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
