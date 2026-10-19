import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
  referenceKey,
  referenceLabel,
  type ChatAttachment,
  type MessageReference,
} from "@carmel-agent/shared";
import {
  BrainIcon,
  Loader2Icon,
  PaperclipIcon,
  ArrowUpIcon,
  SparklesIcon,
  SquareIcon,
  XIcon,
  AtSignIcon,
} from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ReferencePicker } from "./ReferencePicker";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { showError } from "@/lib/errors";
import type { PromptOutcome } from "@/lib/remote-agent";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { attachmentToImageContent, fileToImageAttachment, imageSrc } from "./chat-utils";

const MAX_FILES = 10;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export type ChatInputHandle = {
  insertText: (text: string, references?: MessageReference[]) => void;
};

type ChatInputProps = {
  agentId?: string;
  sessionId?: string;
  canReadFiles?: boolean;
  initialReferences?: MessageReference[];
  onReferencesChange?: (references: MessageReference[]) => void;
  ref?: Ref<ChatInputHandle>;
  leadingActions?: ReactNode;
  /** Focuses the composer on mount, except where that would pop a touch keyboard. */
  autoFocus?: boolean;
  textareaClassName?: string;
  currentModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  initialValue?: string;
  onDraftChange?: (value: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  /**
   * Resolves with what happened to the submission. A rejected message was never
   * taken by the server, so the composer takes it back.
   */
  onSend: (
    text: string,
    images?: ImageContent[],
    references?: MessageReference[],
  ) => Promise<PromptOutcome>;
  onAbort: () => void;
  onModelSelect: () => void;
};

// The draft is deliberately local state: lifting it above the chat panel makes
// every keystroke re-render the full message history. `initialValue`/`onDraftChange`
// let the parent keep the draft in a ref (no re-renders) so it survives remounts,
// e.g. the agent teardown on model switch.
export function ChatInput({
  agentId,
  sessionId,
  canReadFiles = false,
  initialReferences,
  onReferencesChange,
  ref,
  leadingActions,
  autoFocus,
  textareaClassName,
  currentModel,
  thinkingLevel,
  isStreaming,
  initialValue,
  onDraftChange,
  onThinkingLevelChange,
  onSend,
  onAbort,
  onModelSelect,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(initialValue ?? "");
  // Read by the send path after an await, where `value` would be the state it
  // closed over rather than whatever the user has typed since.
  const valueRef = useRef(value);
  const [references, setReferences] = useState<MessageReference[]>(initialReferences ?? []);
  const referencesRef = useRef(references);
  const [pickerOpen, setPickerOpen] = useState(false);
  const mentionRange = useRef({ start: 0, end: 0 });
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
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
  const canSend =
    !isStreaming &&
    !processingFiles &&
    (value.trim().length > 0 || attachments.length > 0 || references.length > 0);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [value]);

  const updateValue = (next: string) => {
    valueRef.current = next;
    setValue(next);
    onDraftChange?.(next);
  };

  const updateReferences = (next: MessageReference[]) => {
    referencesRef.current = next;
    setReferences(next);
    onReferencesChange?.(next);
  };

  const setReferencePickerOpen = (open: boolean) => {
    setPickerOpen(open);
    if (!open)
      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(
          mentionRange.current.start,
          mentionRange.current.start,
        );
      });
  };

  useImperativeHandle(ref, () => ({
    insertText: (text: string, references?: MessageReference[]) => {
      updateValue(text);
      if (references) updateReferences(references);
      textareaRef.current?.focus();
    },
  }));

  const send = () => {
    if (!canSend) return;
    const submittedText = value;
    const submittedAttachments = attachments;
    const submittedReferences = references;
    const images = submittedAttachments.map(attachmentToImageContent);
    // Cleared optimistically, because the send usually succeeds and a composer
    // that empties only after the round trip feels stuck.
    updateValue("");
    setAttachments([]);
    updateReferences([]);
    void onSend(
      submittedText,
      images.length > 0 ? images : undefined,
      submittedReferences.length ? submittedReferences : undefined,
    ).then((outcome) => {
      // Only an outright rejection proves the message was never taken; an
      // `unknown` outcome may have reached the server, and restoring it would
      // invite the user to send it twice. The error notice reports both.
      if (outcome.status !== "rejected") return;
      // Never restore over something typed in the meantime: the composer
      // belongs to the user, and the error notice still carries the reason.
      const restoreDraft = valueRef.current.length === 0 && referencesRef.current.length === 0;
      if (restoreDraft) {
        updateValue(submittedText);
        updateReferences(submittedReferences);
      }
      setAttachments((current) => (current.length === 0 ? submittedAttachments : current));
    });
  };

  const addFiles = async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    if (attachments.length + imageFiles.length > MAX_FILES) {
      toast.error(`Maximum ${MAX_FILES} images allowed.`);
      return;
    }

    setProcessingFiles(true);
    try {
      const nextAttachments: ChatAttachment[] = [];
      for (const file of imageFiles) {
        if (file.size > MAX_FILE_SIZE) {
          toast.error(
            `${file.name} exceeds the ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB limit.`,
          );
          continue;
        }
        nextAttachments.push(await fileToImageAttachment(file));
      }
      setAttachments((current) => [...current, ...nextAttachments]);
    } catch (error) {
      showError("Unable to attach image", error);
    } finally {
      setProcessingFiles(false);
    }
  };

  return (
    <div
      className={cn(
        "chat-composer @container relative min-w-0 rounded-xl border border-border bg-card shadow-sm transition-[border-color,box-shadow] focus-within:border-primary/50 focus-within:shadow-md",
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
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-md border bg-background p-1 pr-2"
            >
              <img
                className="size-8 rounded object-cover"
                src={imageSrc({
                  url: attachment.url,
                  data: attachment.preview ?? attachment.content,
                  mimeType: attachment.mimeType,
                })}
                alt={attachment.fileName}
              />
              <span className="max-w-36 truncate text-xs text-muted-foreground">
                {attachment.fileName}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${attachment.fileName}`}
                onClick={() =>
                  setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                }
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {references.length ? (
        <div className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Selected references">
          {references.map((reference) => (
            <Badge key={referenceKey(reference)} variant="secondary" className="max-w-full gap-1">
              <AtSignIcon />
              <span className="truncate" title={referenceLabel(reference)}>
                {referenceLabel(reference)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove reference ${referenceLabel(reference)}`}
                onClick={() =>
                  updateReferences(
                    references.filter((item) => referenceKey(item) !== referenceKey(reference)),
                  )
                }
              >
                <XIcon />
              </Button>
            </Badge>
          ))}
        </div>
      ) : null}
      <Textarea
        ref={textareaRef}
        value={value}
        rows={2}
        autoFocus={autoFocus && !isTouchPrimaryInput()}
        enterKeyHint="enter"
        placeholder="Type a message..."
        aria-label="Message"
        className={cn(
          "max-h-60 min-h-16 px-3 pt-3 pb-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0",
          textareaClassName,
        )}
        onChange={(event) => {
          const next = event.target.value;
          const cursor = event.target.selectionStart;
          updateValue(next);
          if (
            agentId &&
            next[cursor - 1] === "@" &&
            (cursor === 1 || /\s/.test(next[cursor - 2]!)) &&
            !(event.nativeEvent as InputEvent).isComposing
          ) {
            mentionRange.current = { start: cursor - 1, end: cursor };
            setPickerOpen(true);
          }
        }}
        onPaste={(event) => {
          if (!supportsImages) return;
          const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          );
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
      {/* Use the composer's width so this also fits beside an open workspace pane. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 px-2 pt-1 pb-2">
        <div className="col-start-1 row-start-2 flex items-center gap-2 @[28rem]:row-start-1">
          {leadingActions}
          {agentId ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Mention a reference"
              title="Mention a file, folder, or conversation"
              disabled={isStreaming || references.length >= 10}
              onClick={() => {
                const cursor = textareaRef.current?.selectionStart ?? value.length;
                mentionRange.current = { start: cursor, end: cursor };
                setPickerOpen(true);
              }}
            >
              <AtSignIcon />
            </Button>
          ) : null}
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
        </div>
        <div className="col-span-3 col-start-1 row-start-1 flex min-w-0 items-center gap-2 @[28rem]:col-span-1 @[28rem]:col-start-2 @[28rem]:justify-end">
          {supportsThinking ? (
            <Select
              value={selectedThinkingLevel}
              disabled={isStreaming}
              onValueChange={(level) => onThinkingLevelChange(level as ThinkingLevel)}
            >
              <SelectTrigger
                size="sm"
                aria-label="Thinking level"
                className="shrink-0 border-0 shadow-none"
              >
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start transition-colors @[28rem]:flex-initial"
            aria-label={`Choose model (${currentModel.id})`}
            title={currentModel.id}
            disabled={isStreaming}
            onClick={onModelSelect}
          >
            <SparklesIcon data-icon="inline-start" />
            <span className="truncate">{currentModel.id}</span>
          </Button>
        </div>
        <div className="col-start-3 row-start-2 @[28rem]:row-start-1">
          {isStreaming ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Abort"
              title="Abort"
              onClick={onAbort}
            >
              <SquareIcon />
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              size="icon-sm"
              className="rounded-full"
              disabled={!canSend}
              aria-label="Send"
              title="Send"
              onClick={send}
            >
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </div>
      {agentId ? (
        <ReferencePicker
          agentId={agentId}
          sessionId={sessionId}
          canReadFiles={canReadFiles}
          open={pickerOpen}
          onOpenChange={setReferencePickerOpen}
          onSelect={(reference) => {
            if (!references.some((item) => referenceKey(item) === referenceKey(reference))) {
              if (references.length >= 10) {
                toast.error("Maximum 10 references allowed.");
                return;
              }
              updateReferences([...references, reference]);
            }
            const { start, end } = mentionRange.current;
            updateValue(value.slice(0, start) + value.slice(end));
            setReferencePickerOpen(false);
          }}
        />
      ) : null}
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
