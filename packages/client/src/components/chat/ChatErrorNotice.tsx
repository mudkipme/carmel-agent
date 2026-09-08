import { AlertCircleIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isReconnectingMessage } from "@/lib/remote-agent";

/**
 * The run's request, transport and reconnection failures, which are the ones
 * that reach nothing else: a rejected send never becomes a message, and a lost
 * connection never becomes one either. Without this the chat answers a failed
 * submission with an unchanged, empty transcript.
 *
 * Reconnection is not dismissible, because it clears itself when the stream
 * comes back and hiding it would leave the user watching a chat that is not
 * receiving anything.
 */
export function ChatErrorNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const reconnecting = isReconnectingMessage(message);
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`flex items-start gap-2 border-b px-4 py-2 text-sm ${
        reconnecting ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"
      }`}
    >
      {reconnecting ? (
        <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin" />
      ) : (
        <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {reconnecting ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss error"
          className="-mr-1 shrink-0"
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}
