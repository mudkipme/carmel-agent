import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { ChevronDownIcon, CodeIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatJson, formatToolResult } from "./chat-utils";

type ToolCallViewProps = {
  toolCall: ToolCall;
  result?: ToolResultMessage;
  pending?: boolean;
  aborted?: boolean;
};

export function ToolCallView({ toolCall, result, pending = false, aborted = false }: ToolCallViewProps) {
  const [open, setOpen] = useState(false);
  const isError = aborted || result?.isError;
  const state = pending && !result && !aborted ? "Running" : isError ? "Error" : "Complete";
  const images = getToolResultImages(result);

  return (
    <div className="rounded-md border bg-card text-card-foreground shadow-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {pending && !result ? <Loader2Icon className="animate-spin" /> : <CodeIcon />}
          <span className="truncate">Tool Call: {toolCall.name}</span>
        </span>
        <span className="flex items-center gap-2">
          <Badge variant={isError ? "destructive" : "secondary"}>{state}</Badge>
          <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <CodePanel label="Input" value={formatJson(toolCall.arguments)} />
          <CodePanel label="Output" value={aborted ? "Tool call aborted." : formatToolResult(result)} />
          {images.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1">
              <div className="text-xs font-medium text-muted-foreground">Images</div>
              <div className="flex flex-wrap gap-2">
                {images.map((image, index) => (
                  <figure key={`${image.src}:${index}`} className="w-28 overflow-hidden rounded-md border bg-background">
                    <img className="aspect-square w-full object-cover" src={image.src} alt="Tool result" />
                  </figure>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CodePanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function getToolResultImages(result?: ToolResultMessage) {
  return (
    result?.content
      ?.flatMap((part) => {
        if (part.type !== "image") return [];
        const displayPart = part as typeof part & { data?: string; url?: string };
        const src = displayPart.url ?? (displayPart.data ? `data:${part.mimeType};base64,${displayPart.data}` : undefined);
        return src ? [{ src }] : [];
      }) ?? []
  );
}
