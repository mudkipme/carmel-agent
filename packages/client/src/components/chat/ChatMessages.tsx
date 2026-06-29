import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage as AssistantMessageType, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { AlertCircleIcon } from "lucide-react";
import { MessageActions } from "./MessageActions";
import { MarkdownContent } from "./MarkdownContent";
import { ToolCallView } from "./ToolCallView";
import { ZoomableImage } from "./ZoomableImage";
import {
  buildToolResultsById,
  formatUsage,
  getMessageAttachments,
  getMessageImages,
  getMessageText,
  parseSkillInvocation,
} from "./chat-utils";

type ChatMessagesProps = {
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  pendingToolCalls: ReadonlySet<string>;
  isStreaming: boolean;
  onEditMessage: (message: AgentMessage) => void;
  onRetryMessage: (message: AgentMessage) => void;
  onForkMessage: (message: AgentMessage) => void;
};

type DisplayAssistantContentPart = AssistantMessageType["content"][number] | {
  type: "image";
  data?: string;
  url?: string;
  mimeType: string;
};

export function ChatMessages({
  messages,
  streamingMessage,
  pendingToolCalls,
  isStreaming,
  onEditMessage,
  onRetryMessage,
  onForkMessage,
}: ChatMessagesProps) {
  const toolResultsById = buildToolResultsById(messages);
  const renderMessages =
    streamingMessage && streamingMessage.role !== "toolResult"
      ? [...messages, streamingMessage]
      : messages;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {renderMessages.map((message, index) => {
        if (message.role === "artifact" || message.role === "toolResult") return null;
        const streaming = isStreaming && message === streamingMessage;
        return (
          <MessageItem
            key={`${message.role}:${message.timestamp ?? index}:${index}`}
            message={message}
            toolResultsById={toolResultsById}
            pendingToolCalls={pendingToolCalls}
            streaming={streaming}
            hidePendingToolCalls={!streaming && isStreaming}
            onEditMessage={onEditMessage}
            onRetryMessage={onRetryMessage}
            onForkMessage={onForkMessage}
          />
        );
      })}
    </div>
  );
}

function MessageItem({
  message,
  toolResultsById,
  pendingToolCalls,
  streaming,
  hidePendingToolCalls,
  onEditMessage,
  onRetryMessage,
  onForkMessage,
}: {
  message: AgentMessage;
  toolResultsById: Map<string, ToolResultMessage>;
  pendingToolCalls: ReadonlySet<string>;
  streaming: boolean;
  hidePendingToolCalls: boolean;
  onEditMessage: (message: AgentMessage) => void;
  onRetryMessage: (message: AgentMessage) => void;
  onForkMessage: (message: AgentMessage) => void;
}) {
  if (message.role === "assistant") {
    return (
      <div className="group flex min-w-0 flex-col gap-1">
        <AssistantMessage
          messageForActions={message}
          message={message as AssistantMessageType}
          toolResultsById={toolResultsById}
          pendingToolCalls={pendingToolCalls}
          streaming={streaming}
          hidePendingToolCalls={hidePendingToolCalls}
          onEditMessage={onEditMessage}
          onForkMessage={onForkMessage}
        />
      </div>
    );
  }

  if (message.role === "user" || message.role === "user-with-attachments") {
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
}

function UserMessage({ message }: { message: AgentMessage }) {
  const text = getMessageText(message);
  const skill = parseSkillInvocation(text);
  const images = getMessageImages(message);
  const attachments = getMessageAttachments(message);

  return (
    <div className="flex min-w-0 justify-start px-4">
      <div className="min-w-0 max-w-full rounded-xl bg-muted px-4 py-2 text-sm">
        {skill ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">Using skill: {skill.name}</summary>
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
        {images.length > 0 || attachments.length > 0 ? (
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
            {attachments.map((attachment) =>
              attachment.type === "image" ? (
                <ImagePreview
                  key={attachment.id}
                  data={attachment.preview ?? attachment.content}
                  url={attachment.url}
                  mimeType={attachment.mimeType}
                  label={attachment.fileName}
                />
              ) : (
                <div key={attachment.id} className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">
                  {attachment.fileName}
                </div>
              ),
            )}
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
  streaming,
  hidePendingToolCalls,
  onEditMessage,
  onForkMessage,
}: {
  messageForActions: AgentMessage;
  message: AssistantMessageType;
  toolResultsById: Map<string, ToolResultMessage>;
  pendingToolCalls: ReadonlySet<string>;
  streaming: boolean;
  hidePendingToolCalls: boolean;
  onEditMessage: (message: AgentMessage) => void;
  onForkMessage: (message: AgentMessage) => void;
}) {
  const usageText = !streaming ? formatUsage(message.usage) : "";
  const assistantContent = message.content.filter((part) => part.type !== "toolCall") as DisplayAssistantContentPart[];
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
            <details key={index} className="min-w-0 rounded-md border bg-muted/50 px-3 py-2 text-muted-foreground" open={streaming}>
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
              <ImagePreview data={image.data} url={image.url} mimeType={image.mimeType} label="Image" />
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
            pending={pending}
            aborted={message.stopReason === "aborted" && !result}
          />
        );
      })}
      {usageText ? <div className="text-xs text-muted-foreground">{usageText}</div> : null}
      {message.stopReason === "error" && message.errorMessage ? (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircleIcon />
          <span>{message.errorMessage}</span>
        </div>
      ) : null}
      {message.stopReason === "aborted" ? <div className="text-sm italic text-destructive">Request aborted</div> : null}
    </div>
  );
}

function ImagePreview({ data, url, mimeType, label }: { data?: string; url?: string; mimeType: string; label: string }) {
  const src = url ?? (data ? `data:${mimeType};base64,${data}` : undefined);
  if (!src) return null;

  return <ZoomableImage src={src} alt={label} caption={label} />;
}
