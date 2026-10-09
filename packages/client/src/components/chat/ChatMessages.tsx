import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CodemodeCallInfo } from "@carmel-agent/shared";
import type {
  AssistantMessage as AssistantMessageType,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { AlertCircleIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MessageActions } from "./MessageActions";
import { MarkdownContent } from "./MarkdownContent";
import { ToolCallView } from "./ToolCallView";
import { ZoomableImage } from "./ZoomableImage";
import {
  buildToolResultsById,
  formatUsage,
  getMessageImages,
  getMessageText,
  imageSrc,
  parseSkillInvocation,
} from "./chat-utils";

type ChatMessagesProps = {
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  pendingToolCalls: ReadonlySet<string>;
  codemodeCalls?: ReadonlyMap<string, CodemodeCallInfo[]>;
  isStreaming: boolean;
  /**
   * Fold each run's working -- thinking, tool calls, and the remarks the agent
   * made along the way -- behind one row, leaving the answer it ended on.
   */
  collapseRunDetails?: boolean;
  onEditMessage?: (message: AgentMessage) => void;
  onRetryMessage?: (message: AgentMessage) => void;
  onForkMessage?: (message: AgentMessage) => void;
};

/** A user message, or everything the agent did in answer to one. */
type MessageSegment =
  | { kind: "message"; message: AgentMessage; index: number }
  | { kind: "run"; messages: Array<{ message: AgentMessage; index: number }> };

type DisplayAssistantContentPart =
  | AssistantMessageType["content"][number]
  | {
      type: "image";
      data?: string;
      url?: string;
      mimeType: string;
    };

type MessagePresentation = { hideAnswer?: boolean; hideRunEnding?: boolean };

// Memoized (along with MessageItem below) so re-renders above the chat panel —
// and streaming deltas, which only touch the streaming message — don't re-render
// and re-parse the entire history. Handler props must stay referentially stable.
export const ChatMessages = memo(function ChatMessages({
  messages,
  streamingMessage,
  pendingToolCalls,
  codemodeCalls,
  isStreaming,
  collapseRunDetails = true,
  onEditMessage,
  onRetryMessage,
  onForkMessage,
}: ChatMessagesProps) {
  const toolResultsById = useMemo(() => buildToolResultsById(messages), [messages]);
  const renderMessages =
    streamingMessage && streamingMessage.role !== "toolResult"
      ? [...messages, streamingMessage]
      : messages;

  const renderMessage = (
    message: AgentMessage,
    index: number,
    presentation: MessagePresentation = {},
  ) => {
    if (message.role === "artifact" || message.role === "toolResult") return null;
    const streaming = isStreaming && message === streamingMessage;
    return (
      <MessageItem
        key={`${message.role}:${message.timestamp ?? index}:${index}`}
        message={message}
        toolResultsById={toolResultsById}
        pendingToolCalls={pendingToolCalls}
        codemodeCalls={codemodeCalls}
        streaming={streaming}
        hidePendingToolCalls={!streaming && isStreaming}
        hideAnswer={presentation.hideAnswer}
        hideRunEnding={presentation.hideRunEnding}
        onEditMessage={onEditMessage}
        onRetryMessage={onRetryMessage}
        onForkMessage={onForkMessage}
      />
    );
  };

  if (!collapseRunDetails) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {renderMessages.map((message, index) => renderMessage(message, index))}
      </div>
    );
  }

  const segments = segmentByRun(renderMessages);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {segments.map((segment, segmentIndex) =>
        segment.kind === "message" ? (
          renderMessage(segment.message, segment.index)
        ) : (
          <CollapsedRun
            key={`run:${segment.messages[0]!.index}`}
            messages={segment.messages}
            active={isStreaming && segmentIndex === segments.length - 1}
            renderMessage={renderMessage}
            onEditMessage={onEditMessage}
            onForkMessage={onForkMessage}
          />
        ),
      )}
    </div>
  );
});

function segmentByRun(messages: AgentMessage[]): MessageSegment[] {
  const segments: MessageSegment[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      segments.push({ kind: "message", message, index });
      return;
    }
    const last = segments.at(-1);
    if (last?.kind === "run") last.messages.push({ message, index });
    else segments.push({ kind: "run", messages: [{ message, index }] });
  });
  return segments;
}

/**
 * One run, folded down to the answer it ended on. The row above the answer
 * says how much work is folded away and opens it above the answer. The answer
 * stays outside the work details. A run with nothing to fold renders as it is.
 */
function CollapsedRun({
  messages,
  active,
  renderMessage,
  onEditMessage,
  onForkMessage,
}: {
  messages: Array<{ message: AgentMessage; index: number }>;
  /** The agent is still working on this run. */
  active: boolean;
  renderMessage: (
    message: AgentMessage,
    index: number,
    presentation?: MessagePresentation,
  ) => ReactNode;
  onEditMessage?: (message: AgentMessage) => void;
  onForkMessage?: (message: AgentMessage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const assistants = messages.filter(
    (entry): entry is { message: AssistantMessageType; index: number } =>
      entry.message.role === "assistant",
  );
  const answer = [...assistants]
    .reverse()
    .find(
      (entry) =>
        hasText(entry.message) ||
        entry.message.content.some((part) => (part as { type: string }).type === "image"),
    );
  const last = assistants.at(-1);
  const toolCalls = assistants.reduce(
    (count, entry) =>
      count + entry.message.content.filter((part) => part.type === "toolCall").length,
    0,
  );
  const thought = assistants.some((entry) =>
    entry.message.content.some((part) => part.type === "thinking" && part.thinking.trim()),
  );
  const remarks = assistants.filter((entry) => entry !== answer && hasText(entry.message)).length;
  const folded = toolCalls > 0 || thought || remarks > 0;

  if (!folded && !active)
    return <>{messages.map((entry) => renderMessage(entry.message, entry.index))}</>;

  const summary = [
    toolCalls > 0 ? `${toolCalls} tool call${toolCalls === 1 ? "" : "s"}` : "",
    thought ? "thinking" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const currentTool = active ? runningToolName(last?.message) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <button
        type="button"
        aria-expanded={expanded}
        className="mx-4 flex w-fit max-w-[calc(100%-2rem)] items-center gap-1.5 rounded-md py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        {active ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
          />
        )}
        <span className="truncate">
          {active
            ? currentTool
              ? `Working · ${currentTool}`
              : "Working"
            : expanded
              ? "Hide work"
              : "Show work"}
          {summary ? ` · ${summary}` : ""}
        </span>
      </button>
      {expanded ? (
        <div className="flex min-w-0 flex-col gap-4 border-l-2 border-border/60 pl-1">
          {messages.map((entry) =>
            renderMessage(entry.message, entry.index, {
              hideAnswer: entry === answer,
              hideRunEnding: entry === last,
            }),
          )}
        </div>
      ) : null}
      {answer ? (
        <AnswerOnly
          message={answer.message}
          onEditMessage={active ? undefined : onEditMessage}
          onForkMessage={onForkMessage}
        />
      ) : null}
      {last ? <RunEnding message={last.message} /> : null}
    </div>
  );
}

function hasText(message: AssistantMessageType) {
  return message.content.some((part) => part.type === "text" && part.text.trim());
}

function runningToolName(message?: AssistantMessageType) {
  return message?.content.filter((part): part is ToolCall => part.type === "toolCall").at(-1)?.name;
}

/** An assistant message's prose, with its working and its usage line left out. */
function AnswerOnly({
  message,
  onEditMessage,
  onForkMessage,
}: {
  message: AssistantMessageType;
  onEditMessage?: (message: AgentMessage) => void;
  onForkMessage?: (message: AgentMessage) => void;
}) {
  const text = message.content
    .filter((part) => part.type === "text" && part.text.trim())
    .map((part) => (part as { text: string }).text)
    .join("\n\n");
  return (
    <div className="group flex min-w-0 flex-col gap-1 px-4 text-sm">
      <MarkdownContent content={text} />
      {(message.content as DisplayAssistantContentPart[]).map((part, index) =>
        part.type === "image" ? (
          <ImagePreview
            key={index}
            data={part.data}
            url={part.url}
            mimeType={part.mimeType}
            label="Image"
          />
        ) : null,
      )}
      <div className="-mt-1">
        <MessageActions message={message} onEdit={onEditMessage} onFork={onForkMessage} />
      </div>
    </div>
  );
}

/** How a run ended, when that was not an answer: an error or a stop. */
function RunEnding({ message }: { message: AssistantMessageType }) {
  if (message.stopReason === "error" && message.errorMessage) {
    return (
      <div className="mx-4 flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        <AlertCircleIcon />
        <span>{message.errorMessage}</span>
      </div>
    );
  }
  if (message.stopReason === "aborted")
    return <div className="px-4 text-sm italic text-destructive">Interrupted</div>;
  return null;
}

const MessageItem = memo(function MessageItem({
  message,
  toolResultsById,
  pendingToolCalls,
  codemodeCalls,
  streaming,
  hidePendingToolCalls,
  hideAnswer,
  hideRunEnding,
  onEditMessage,
  onRetryMessage,
  onForkMessage,
}: {
  message: AgentMessage;
  toolResultsById: Map<string, ToolResultMessage>;
  pendingToolCalls: ReadonlySet<string>;
  codemodeCalls?: ReadonlyMap<string, CodemodeCallInfo[]>;
  streaming: boolean;
  hidePendingToolCalls: boolean;
  hideAnswer?: boolean;
  hideRunEnding?: boolean;
  onEditMessage?: (message: AgentMessage) => void;
  onRetryMessage?: (message: AgentMessage) => void;
  onForkMessage?: (message: AgentMessage) => void;
}) {
  if (message.role === "assistant") {
    return (
      <div className="group flex min-w-0 flex-col gap-1">
        <AssistantMessage
          messageForActions={message}
          message={message as AssistantMessageType}
          toolResultsById={toolResultsById}
          pendingToolCalls={pendingToolCalls}
          codemodeCalls={codemodeCalls}
          streaming={streaming}
          hidePendingToolCalls={hidePendingToolCalls}
          hideAnswer={hideAnswer}
          hideRunEnding={hideRunEnding}
          onEditMessage={onEditMessage}
          onForkMessage={onForkMessage}
        />
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="group flex min-w-0 flex-col gap-1">
        <UserMessage message={message} />
        <div className="px-4">
          <MessageActions
            message={message}
            onEdit={onEditMessage}
            onRetry={onRetryMessage}
            onFork={onForkMessage}
          />
        </div>
      </div>
    );
  }

  return null;
});

function UserMessage({ message }: { message: AgentMessage }) {
  const text = getMessageText(message);
  const skill = parseSkillInvocation(text);
  const images = getMessageImages(message);

  return (
    <div className="flex min-w-0 justify-start px-4">
      <div className="min-w-0 max-w-full rounded-lg bg-secondary px-3.5 py-2 text-sm">
        {skill ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Using skill: {skill.name}
            </summary>
            <div className="mt-2 border-l pl-3 text-xs text-muted-foreground">
              <div className="truncate">{skill.location}</div>
              <MarkdownContent content={skill.body} />
            </div>
            {skill.prompt ? (
              <div className="mt-3">
                <MarkdownContent content={skill.prompt} />
              </div>
            ) : null}
          </details>
        ) : text ? (
          <MarkdownContent content={text} />
        ) : null}
        {images.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {images.map((image, index) => (
              <ImagePreview
                key={`${image.mimeType}:${image.url ?? index}`}
                data={image.data}
                url={image.url}
                mimeType={image.mimeType}
                label="Image"
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantMessage({
  messageForActions,
  message,
  toolResultsById,
  pendingToolCalls,
  codemodeCalls,
  streaming,
  hidePendingToolCalls,
  hideAnswer = false,
  hideRunEnding = false,
  onEditMessage,
  onForkMessage,
}: {
  messageForActions: AgentMessage;
  message: AssistantMessageType;
  toolResultsById: Map<string, ToolResultMessage>;
  pendingToolCalls: ReadonlySet<string>;
  codemodeCalls?: ReadonlyMap<string, CodemodeCallInfo[]>;
  streaming: boolean;
  hidePendingToolCalls: boolean;
  hideAnswer?: boolean;
  hideRunEnding?: boolean;
  onEditMessage?: (message: AgentMessage) => void;
  onForkMessage?: (message: AgentMessage) => void;
}) {
  const usageText = !streaming ? formatUsage(message.usage) : "";
  const assistantContent = (message.content as DisplayAssistantContentPart[]).filter(
    (part) =>
      part.type !== "toolCall" && (!hideAnswer || (part.type !== "text" && part.type !== "image")),
  );
  const toolCalls = message.content.filter((part) => part.type === "toolCall");
  const lastTextIndex = assistantContent.reduce(
    (lastIndex, part, index) => (part.type === "text" && part.text.trim() ? index : lastIndex),
    -1,
  );

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 text-sm">
      {assistantContent.map((part, index) => {
        if (part.type === "text" && part.text.trim()) {
          return (
            <div key={index} className="flex min-w-0 flex-col gap-1">
              <MarkdownContent content={part.text} />
              {index === lastTextIndex ? (
                <div className="-mt-1">
                  <MessageActions
                    message={messageForActions}
                    onEdit={streaming ? undefined : onEditMessage}
                    onFork={onForkMessage}
                  />
                </div>
              ) : null}
            </div>
          );
        }
        if (part.type === "thinking" && part.thinking.trim()) {
          return (
            <details
              key={index}
              className="min-w-0 border-l pl-3 text-muted-foreground"
              open={streaming}
            >
              <summary className="cursor-pointer text-xs font-medium">Thinking</summary>
              <div className="mt-2">
                <MarkdownContent content={part.thinking} thinking />
              </div>
            </details>
          );
        }
        if (part.type === "image") {
          const image = part as typeof part & { data?: string; url?: string };
          return (
            <div key={index}>
              <ImagePreview
                data={image.data}
                url={image.url}
                mimeType={image.mimeType}
                label="Image"
              />
            </div>
          );
        }
        return null;
      })}
      {toolCalls.map((part) => {
        const toolCall = part as ToolCall;
        const pending = pendingToolCalls.has(toolCall.id);
        const result = toolResultsById.get(toolCall.id);
        if (hidePendingToolCalls && pending && !result) return null;
        return (
          <ToolCallView
            key={toolCall.id}
            toolCall={toolCall}
            result={result}
            codemodeCalls={codemodeCalls?.get(toolCall.id)}
            pending={pending}
            streaming={streaming}
            aborted={message.stopReason === "aborted" && !result}
          />
        );
      })}
      {usageText ? <div className="text-xs text-muted-foreground">{usageText}</div> : null}
      {!hideRunEnding && message.stopReason === "error" && message.errorMessage ? (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircleIcon />
          <span>{message.errorMessage}</span>
        </div>
      ) : null}
      {!hideRunEnding && message.stopReason === "aborted" ? (
        <div className="text-sm italic text-destructive">Request aborted</div>
      ) : null}
    </div>
  );
}

function ImagePreview({
  data,
  url,
  mimeType,
  label,
}: {
  data?: string;
  url?: string;
  mimeType: string;
  label: string;
}) {
  const src = imageSrc({ url, data, mimeType });
  if (!src) return null;

  return <ZoomableImage src={src} alt={label} caption={label} />;
}
