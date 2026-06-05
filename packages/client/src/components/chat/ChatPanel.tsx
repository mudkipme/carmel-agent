import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";

type ChatPanelProps = {
  scrollResetKey: string;
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  pendingToolCalls: ReadonlySet<string>;
  isStreaming: boolean;
  currentModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  input: string;
  onInputChange: (value: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onSend: (text: string, images?: ImageContent[]) => void;
  onAbort: () => void;
  onModelSelect: () => void;
  onEditMessage: (message: AgentMessage) => void;
  onRetryMessage: (message: AgentMessage) => void;
  onForkMessage: (message: AgentMessage) => void;
};

export function ChatPanel({
  scrollResetKey,
  messages,
  streamingMessage,
  pendingToolCalls,
  isStreaming,
  currentModel,
  thinkingLevel,
  input,
  onInputChange,
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
        <div ref={contentRef} className="mx-auto flex w-full max-w-3xl min-w-0 flex-col px-3 py-4">
          <ChatMessages
            messages={messages}
            streamingMessage={streamingMessage}
            pendingToolCalls={pendingToolCalls}
            isStreaming={isStreaming}
            onEditMessage={onEditMessage}
            onRetryMessage={onRetryMessage}
            onForkMessage={onForkMessage}
          />
        </div>
      </div>
      <div className="shrink-0 px-3 pb-3">
        <div className="mx-auto w-full max-w-3xl min-w-0">
          <ChatInput
            value={input}
            currentModel={currentModel}
            thinkingLevel={thinkingLevel}
            isStreaming={isStreaming}
            onValueChange={onInputChange}
            onThinkingLevelChange={onThinkingLevelChange}
            onSend={onSend}
            onAbort={onAbort}
            onModelSelect={onModelSelect}
          />
        </div>
      </div>
    </div>
  );
}
