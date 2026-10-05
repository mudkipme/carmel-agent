import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessageEditOptions } from "@carmel-agent/shared";
import { XIcon } from "lucide-react";
import type { EditableUserImage } from "@/components/chat/chat-utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  fullscreenDialogContentClass,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export type MessageEditState = {
  message: AgentMessage;
  draft: string;
  kind: "user" | "assistant";
  images: EditableUserImage[];
  removedKeys: Set<string>;
};

export function MessageEditDialog({
  value,
  onChange,
  onSave,
}: {
  value: MessageEditState | null;
  onChange: (value: MessageEditState | null) => void;
  onSave: (value: MessageEditState, submit: boolean, removals: UserMessageEditOptions) => Promise<void>;
}) {
  const survivingImages = value ? value.images.filter((image) => !value.removedKeys.has(image.key)) : [];
  const canCommit = value
    ? value.kind === "assistant"
      ? Boolean(value.draft.trim())
      : Boolean(value.draft.trim()) || survivingImages.length > 0
    : false;

  const save = async (submit: boolean) => {
    if (!value) return;
    onChange(null);
    await onSave(value, submit, computeImageRemovals(value.images, value.removedKeys));
  };

  const removeImage = (key: string) => {
    if (!value) return;
    const removedKeys = new Set(value.removedKeys);
    removedKeys.add(key);
    onChange({ ...value, removedKeys });
  };

  return (
    <Dialog open={value !== null} onOpenChange={(open) => !open && onChange(null)}>
      <DialogContent className={fullscreenDialogContentClass("sm:max-w-4xl")}>
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="text-base sm:text-lg">
            {value?.kind === "assistant" ? "Edit Assistant Message" : "Edit Message"}
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            {value?.kind === "assistant"
              ? "Rewrites this assistant message in place. It won't rerun anything and only affects the next turn."
              : "Save updates the message only. Submit saves it and reruns from this point."}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          className="min-h-0 flex-1 resize-none overflow-y-auto text-base sm:max-h-[60vh] sm:min-h-36 sm:flex-none sm:resize-y"
          value={value?.draft ?? ""}
          onChange={(event) => value && onChange({ ...value, draft: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canCommit) {
              event.preventDefault();
              void save(value?.kind === "user");
            }
          }}
        />
        {value?.kind === "user" && survivingImages.length > 0 ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {survivingImages.map((image) => (
              <div key={image.key} className="relative">
                <img className="size-20 rounded-md border object-cover" src={image.src} alt={image.label} />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-xs"
                  className="absolute -right-2 -top-2 rounded-full border shadow-xs"
                  aria-label={`Remove ${image.label}`}
                  onClick={() => removeImage(image.key)}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onChange(null)}>Cancel</Button>
          <Button variant={value?.kind === "assistant" ? undefined : "outline"} disabled={!canCommit} onClick={() => void save(false)}>
            Save
          </Button>
          {value?.kind === "assistant" ? null : (
            <Button disabled={!canCommit} onClick={() => void save(true)}>Submit</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function computeImageRemovals(images: EditableUserImage[], removedKeys: Set<string>): UserMessageEditOptions {
  const removedImageIndexes: number[] = [];
  for (const image of images) {
    if (!removedKeys.has(image.key)) continue;
    removedImageIndexes.push(image.removal.index);
  }
  return { removedImageIndexes };
}
