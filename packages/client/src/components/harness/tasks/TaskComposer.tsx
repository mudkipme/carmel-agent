import type { Ref } from "react";
import { ArrowUpIcon, MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function TaskComposer({
  inputRef,
  message,
  onChange,
  onSend,
  onSaveNote,
  busy,
  sendLabel,
  placeholder,
  fresh,
}: {
  inputRef: Ref<HTMLTextAreaElement>;
  message: string;
  onChange: (text: string) => void;
  onSend?: () => void;
  onSaveNote: () => void;
  busy: boolean;
  sendLabel: string;
  placeholder: string;
  fresh: boolean;
}) {
  const canSend = !busy && Boolean(message.trim());
  return (
    <div className="shrink-0 px-3 pt-2 pb-[calc(0.75rem+var(--safe-bottom))] sm:px-4">
      <form
        aria-label="Task reply"
        className="chat-composer mx-auto flex w-full max-w-[var(--line-width)] flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) (onSend ?? onSaveNote)();
        }}
      >
        <Textarea
          ref={inputRef}
          id="issue-reply"
          aria-label="Message"
          value={message}
          maxLength={20000}
          className="max-h-40 min-h-16 resize-none border-0 bg-transparent px-1 py-0 shadow-none focus-visible:ring-0"
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) (onSend ?? onSaveNote)();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Reply options">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={!canSend} onSelect={onSaveNote}>
                  Save as note
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center gap-2">
            {fresh ? <Badge variant="secondary">Fresh conversation</Badge> : null}
            <Button type="submit" size="sm" disabled={!canSend}>
              {onSend ? sendLabel : "Save note"}
              <ArrowUpIcon data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
