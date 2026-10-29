import { useLingui } from "@lingui/react";
import type { ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  fullscreenDialogContentClass,
} from "@/components/ui/dialog";

export function TaskPanel({
  title,
  inline,
  onClose,
  children,
}: {
  title: string;
  inline: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { i18n } = useLingui();
  if (inline)
    return (
      <aside aria-label={title} className="flex w-96 shrink-0 flex-col border-l">
        <div className="flex items-center justify-between px-5 py-3">
          <h2 className="text-sm font-medium">{title}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={i18n._("Close {value}", { value: title.toLowerCase() })}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
      </aside>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={fullscreenDialogContentClass("sm:max-w-xl")}
        aria-describedby={undefined}
        showCloseButton={false}
      >
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{title}</DialogTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={i18n._("Close {value}", { value: title.toLowerCase() })}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pt-3">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
