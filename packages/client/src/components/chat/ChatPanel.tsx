import { useHarnessStore } from "@/store/harness-store";
import { draftStorageKey } from "@/lib/session-draft";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { NestedToolSlot, MessageReference } from "@carmel-agent/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type Ref,
} from "react";
import type { PromptOutcome } from "@/lib/remote-agent";
import { Button } from "@/components/ui/button";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { AgentRequestArea } from "./AgentRequestCard";

type ChatPanelProps = {
  agentId: string;
  sessionId: string;
  canReadFiles: boolean;
  canWriteFiles: boolean;
  initialReferences?: MessageReference[];
  onReferencesChange?: (references: MessageReference[]) => void;
  readOnly?: boolean;
  allowQueuedInput?: boolean;
  onAtBottomChange?: (atBottom: boolean) => void;
  onLoadEarlier?: () => Promise<void>;
  onLoadLatest?: () => Promise<void>;
  scrollResetKey: string;
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  pendingToolCalls: ReadonlySet<string>;
  nestedTools?: readonly NestedToolSlot[];
  isStreaming: boolean;
  collapseRunDetails?: boolean;
  currentModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  inputRef?: Ref<ChatInputHandle>;
  inputLeadingActions?: ReactNode;
  requestCards?: ReactNode;
  pendingSecretCards?: ReactNode;
  renderCompletedSecret?: (requestId: string) => ReactNode;
  waitingForAnswer?: boolean;
  initialInput?: string;
  onInputDraftChange?: (value: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onSend: (
    text: string,
    images?: ImageContent[],
    references?: MessageReference[],
  ) => Promise<PromptOutcome>;
  onAbort: () => void;
  onModelSelect: () => void;
  onEditMessage: (message: AgentMessage) => void;
  onRetryMessage: (message: AgentMessage) => void;
  onForkMessage: (message: AgentMessage) => void;
};

export function ChatPanel({
  agentId,
  sessionId,
  canReadFiles,
  canWriteFiles,
  initialReferences,
  onReferencesChange,
  readOnly,
  allowQueuedInput,
  onAtBottomChange,
  onLoadEarlier,
  onLoadLatest,
  scrollResetKey,
  messages,
  streamingMessage,
  pendingToolCalls,
  nestedTools,
  isStreaming,
  collapseRunDetails,
  currentModel,
  thinkingLevel,
  inputRef,
  inputLeadingActions,
  requestCards,
  pendingSecretCards,
  renderCompletedSecret,
  waitingForAnswer,
  initialInput,
  onInputDraftChange,
  onThinkingLevelChange,
  onSend,
  onAbort,
  onModelSelect,
  onEditMessage,
  onRetryMessage,
  onForkMessage,
}: ChatPanelProps) {
  const userId = useHarnessStore((state) => state.activeUserId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);
  const renderKey = useMemo(
    () =>
      `${messages.length}:${streamingMessage?.timestamp ?? ""}:${isStreaming ? "streaming" : "idle"}`,
    [isStreaming, messages.length, streamingMessage?.timestamp],
  );

  useLayoutEffect(() => {
    autoScrollRef.current = true;
    scrollToBottom();
    const frame = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [scrollResetKey, scrollToBottom]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    if (!scrollElement || !contentElement) return;

    const observer = new ResizeObserver(() => {
      if (autoScrollRef.current) scrollElement.scrollTop = scrollElement.scrollHeight;
    });
    observer.observe(contentElement);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (autoScrollRef.current) scrollToBottom();
  }, [renderKey, scrollToBottom]);

  return (
    <div className="agent-chat-host flex h-full min-h-0 flex-col bg-background text-foreground">
      <div
        ref={scrollRef}
        data-chat-history
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          const distanceFromBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight;
          autoScrollRef.current = distanceFromBottom < 48;
          onAtBottomChange?.(autoScrollRef.current);
        }}
      >
        <div
          ref={contentRef}
          className="mx-auto flex w-full max-w-[var(--line-width)] min-w-0 flex-col px-2 pt-5 pb-4 sm:px-4"
        >
          {onLoadEarlier || onLoadLatest ? (
            <div className="flex justify-center gap-2 pb-3">
              {onLoadEarlier ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isStreaming}
                  onClick={() => {
                    const element = scrollRef.current;
                    const height = element?.scrollHeight ?? 0;
                    const top = element?.scrollTop ?? 0;
                    autoScrollRef.current = false;
                    void onLoadEarlier().then(() =>
                      requestAnimationFrame(() => {
                        if (element) element.scrollTop = top + element.scrollHeight - height;
                      }),
                    );
                  }}
                >
                  Earlier messages
                </Button>
              ) : null}
              {onLoadLatest ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    autoScrollRef.current = true;
                    void onLoadLatest();
                  }}
                >
                  Latest messages
                </Button>
              ) : null}
            </div>
          ) : null}
          <ChatMessages
            messages={messages}
            streamingMessage={streamingMessage}
            pendingToolCalls={pendingToolCalls}
            nestedTools={nestedTools}
            isStreaming={isStreaming}
            collapseRunDetails={collapseRunDetails}
            renderCompletedSecret={renderCompletedSecret}
            onEditMessage={readOnly ? undefined : onEditMessage}
            onRetryMessage={readOnly ? undefined : onRetryMessage}
            onForkMessage={readOnly ? undefined : onForkMessage}
          />
          {pendingSecretCards ? <div className="py-3">{pendingSecretCards}</div> : null}
        </div>
      </div>
      <AgentRequestArea>{requestCards}</AgentRequestArea>
      {!readOnly ? (
        <div
          hidden={waitingForAnswer}
          className="shrink-0 px-3 pt-2 pb-[calc(0.75rem+var(--safe-bottom))] sm:px-4"
        >
          <div className="mx-auto w-full max-w-[var(--line-width)] min-w-0">
            <ChatInput
              draftKey={draftStorageKey(userId, "session", sessionId)}
              agentId={agentId}
              sessionId={sessionId}
              canReadFiles={canReadFiles}
              canWriteFiles={canWriteFiles}
              initialReferences={initialReferences}
              onReferencesChange={onReferencesChange}
              ref={inputRef}
              leadingActions={inputLeadingActions}
              currentModel={currentModel}
              thinkingLevel={thinkingLevel}
              isStreaming={allowQueuedInput ? false : isStreaming}
              initialValue={initialInput}
              onDraftChange={onInputDraftChange}
              onThinkingLevelChange={onThinkingLevelChange}
              onSend={onSend}
              onAbort={onAbort}
              onModelSelect={onModelSelect}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
