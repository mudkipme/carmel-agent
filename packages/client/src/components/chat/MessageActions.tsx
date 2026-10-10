import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CheckIcon, CopyIcon, GitForkIcon, PencilIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText, getMessageText } from "./chat-utils";
import { isEditableAssistantMessage, isUserMessage } from "@carmel-agent/shared";

type MessageActionsProps = {
  message: AgentMessage;
  onEdit?: (message: AgentMessage) => void;
  onRetry?: (message: AgentMessage) => void;
  onFork?: (message: AgentMessage) => void;
};

export function MessageActions({ message, onEdit, onRetry, onFork }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  const copyValue = getMessageText(message);
  const isUser = isUserMessage(message);
  const canEdit = isUser || isEditableAssistantMessage(message);

  return (
    <div className="coarse-pointer-visible flex h-6 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      {copyValue ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title={copied ? "Copied" : "Copy message"}
          aria-label={copied ? "Copied" : "Copy message"}
          onClick={() =>
            void copyText(copyValue)
              .then(() => setCopied(true))
              .catch(() => toast.error("Unable to copy message"))
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      ) : null}
      {onFork ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title="Fork from this message"
          aria-label="Fork from this message"
          onClick={() => onFork(message)}
        >
          <GitForkIcon />
        </Button>
      ) : null}
      {onEdit && canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title="Edit message"
          aria-label="Edit message"
          onClick={() => onEdit(message)}
        >
          <PencilIcon />
        </Button>
      ) : null}
      {onRetry && isUser ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title="Retry from this message"
          aria-label="Retry from this message"
          onClick={() => onRetry(message)}
        >
          <RotateCcwIcon />
        </Button>
      ) : null}
    </div>
  );
}
