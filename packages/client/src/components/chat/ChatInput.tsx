import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { BrainIcon, Loader2Icon, PaperclipIcon, SendIcon, SparklesIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { attachmentToImageContent, fileToImageAttachment, type LocalChatAttachment } from "./chat-utils";

const MAX_FILES = 10;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

type ChatInputProps = {
  value: string;
  currentModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  onValueChange: (value: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onSend: (text: string, images?: ImageContent[]) => void;
  onAbort: () => void;
  onModelSelect: () => void;
};

export function ChatInput({
  value,
  currentModel,
  thinkingLevel,
  isStreaming,
  onValueChange,
  onThinkingLevelChange,
  onSend,
  onAbort,
  onModelSelect,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<LocalChatAttachment[]>([]);
  const [processingFiles, setProcessingFiles] = useState(false);
  const [dragging, setDragging] = useState(false);
  const supportedThinkingLevels = useMemo(
    () => getSupportedThinkingLevels(currentModel) as ThinkingLevel[],
    [currentModel],
  );
  const selectedThinkingLevel = supportedThinkingLevels.includes(thinkingLevel)
    ? thinkingLevel
    : (supportedThinkingLevels[0] ?? "off");
  const supportsThinking = supportedThinkingLevels.some((level) => level !== "off");
  const supportsImages = currentModel.input?.includes("image") !== false;
  const canSend = !isStreaming && !processingFiles && (value.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [value]);

  const send = () => {
    if (!canSend) return;
    const images = attachments.map(attachmentToImageContent);
    onSend(value, images.length > 0 ? images : undefined);
    onValueChange("");
    setAttachments([]);
  };

  const addFiles = async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    if (attachments.length + imageFiles.length > MAX_FILES) {
      window.alert(`Maximum ${MAX_FILES} images allowed.`);
      return;
    }

    setProcessingFiles(true);
    try {
      const nextAttachments: LocalChatAttachment[] = [];
      for (const file of imageFiles) {
        if (file.size > MAX_FILE_SIZE) {
          window.alert(`${file.name} exceeds the ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB limit.`);
          continue;
        }
        nextAttachments.push(await fileToImageAttachment(file));
      }
      setAttachments((current) => [...current, ...nextAttachments]);
    } catch (error) {
      console.error("Failed to attach image", error);
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setProcessingFiles(false);
    }
  };

  return (
    <div
      className={cn(
        "relative rounded-lg border bg-card shadow-xs",
        dragging && "border-primary bg-primary/5",
      )}
      onDragOver={(event) => {
        if (!supportsImages) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX <= rect.left ||
          event.clientX >= rect.right ||
          event.clientY <= rect.top ||
          event.clientY >= rect.bottom
        ) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (!supportsImages) return;
        event.preventDefault();
        setDragging(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-primary/10 text-sm font-medium text-primary">
          Drop images here
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="flex items-center gap-2 rounded-md border bg-background p-1 pr-2">
              <img
                className="size-8 rounded object-cover"
                src={`data:${attachment.mimeType};base64,${attachment.preview ?? attachment.content}`}
                alt={attachment.fileName}
              />
              <span className="max-w-36 truncate text-xs text-muted-foreground">{attachment.fileName}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${attachment.fileName}`}
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <Textarea
        ref={textareaRef}
        value={value}
        rows={2}
        enterKeyHint="enter"
        placeholder="Type a message..."
        className="max-h-60 min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        onChange={(event) => onValueChange(event.target.value)}
        onPaste={(event) => {
          if (!supportsImages) return;
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
          if (files.length === 0) return;
          event.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.key === "Process") return;
          if (event.key === "Enter" && shouldSubmitOnEnter(event)) {
            event.preventDefault();
            send();
          }
          if (event.key === "Escape" && isStreaming) {
            event.preventDefault();
            onAbort();
          }
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          void addFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <div className="flex items-center justify-between gap-2 px-2 pt-1 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {supportsImages ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={processingFiles}
              aria-label="Attach images"
              title="Attach images"
              onClick={() => fileInputRef.current?.click()}
            >
              {processingFiles ? <Loader2Icon className="animate-spin" /> : <PaperclipIcon />}
            </Button>
          ) : null}
          {supportsThinking ? (
            <Select value={selectedThinkingLevel} onValueChange={(level) => onThinkingLevelChange(level as ThinkingLevel)}>
              <SelectTrigger size="sm" className="max-w-32 border-0 shadow-none">
                <BrainIcon />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {supportedThinkingLevels.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" className="min-w-0" onClick={onModelSelect}>
            <SparklesIcon data-icon="inline-start" />
            <span className="truncate">{currentModel.id}</span>
          </Button>
          {isStreaming ? (
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Abort" title="Abort" onClick={onAbort}>
              <SquareIcon />
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="icon-sm" disabled={!canSend} aria-label="Send" title="Send" onClick={send}>
              <SendIcon />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function shouldSubmitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.shiftKey) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return !isTouchPrimaryInput();
}

function isTouchPrimaryInput() {
  return window.matchMedia("(pointer: coarse), (hover: none)").matches;
}
