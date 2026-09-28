import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type Ref } from "react";
import type { PromptOutcome } from "@/lib/remote-agent";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";

type ChatPanelProps = {
  readOnly?: boolean;
  scrollResetKey: string;
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  pendingToolCalls: ReadonlySet<string>;
  isStreaming: boolean;
  collapseRunDetails?: boolean;
  currentModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  inputRef?: Ref<ChatInputHandle>;
  inputLeadingActions?: ReactNode;
  initialInput?: string;
  onInputDraftChange?: (value: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onSend: (text: string, images?: ImageContent[]) => Promise<PromptOutcome>;
  onAbort: () => void;
  onModelSelect: () => void;
  onEditMessage: (message: AgentMessage) => void;
  onRetryMessage: (message: AgentMessage) => void;
  onForkMessage: (message: AgentMessage) => void;
};

export function ChatPanel({
  readOnly,
  scrollResetKey,
  messages,
  streamingMessage,
  pendingToolCalls,
  isStreaming,
  collapseRunDetails,
  currentModel,
  thinkingLevel,
  inputRef,
  inputLeadingActions,
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);
  const renderKey = useMemo(
    () => `${messages.length}:${streamingMessage?.timestamp ?? ""}:${isStreaming ? "streaming" : "idle"}`,
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
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (autoScrollRef.current) scrollToBottom();
  }, [renderKey, scrollToBottom]);

  return (
    <div className="agent-chat-host flex h-full min-h-0 flex-col bg-background text-foreground">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
          autoScrollRef.current = distanceFromBottom < 48;
        }}
      >
        <div ref={contentRef} className="mx-auto flex w-full max-w-[var(--line-width)] min-w-0 flex-col px-3 py-4">
          <ChatMessages
            messages={messages}
            streamingMessage={streamingMessage}
            pendingToolCalls={pendingToolCalls}
            isStreaming={isStreaming}
            collapseRunDetails={collapseRunDetails}
            onEditMessage={readOnly ? undefined : onEditMessage}
            onRetryMessage={readOnly ? undefined : onRetryMessage}
            onForkMessage={readOnly ? undefined : onForkMessage}
          />
        </div>
      </div>
      {!readOnly ? <div className="shrink-0 px-3 pb-[calc(0.75rem+var(--safe-bottom))]">
        <div className="mx-auto w-full max-w-[var(--line-width)] min-w-0">
          <ChatInput
            ref={inputRef}
            leadingActions={inputLeadingActions}
            currentModel={currentModel}
            thinkingLevel={thinkingLevel}
            isStreaming={isStreaming}
            initialValue={initialInput}
            onDraftChange={onInputDraftChange}
            onThinkingLevelChange={onThinkingLevelChange}
            onSend={onSend}
            onAbort={onAbort}
            onModelSelect={onModelSelect}
          />
        </div>
      </div> : null}
    </div>
  );
}
