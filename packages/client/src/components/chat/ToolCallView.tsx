import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { codemodeCallsSchema, type CodemodeCallInfo } from "@carmel-agent/shared";
import { ChevronDownIcon, CodeIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatJson, formatToolResult, imageSrc } from "./chat-utils";
import { ZoomableImage } from "./ZoomableImage";

type ToolCallViewProps = {
  toolCall: ToolCall;
  result?: ToolResultMessage;
  pending?: boolean;
  streaming?: boolean;
  aborted?: boolean;
  codemodeCalls?: CodemodeCallInfo[];
};

export function ToolCallView({
  toolCall,
  result,
  pending = false,
  streaming = false,
  aborted = false,
  codemodeCalls,
}: ToolCallViewProps) {
  const [open, setOpen] = useState(false);
  const isError = aborted || result?.isError;
  const state = isError
    ? "Error"
    : result
      ? "Complete"
      : pending
        ? "Running"
        : streaming
          ? "Preparing"
          : "Pending";
  const active = state === "Preparing" || state === "Running";
  const images = getToolResultImages(result);
  const details = result?.details as { codemodeCalls?: unknown } | undefined;
  const savedCalls = codemodeCallsSchema.safeParse(details?.codemodeCalls);
  const calls = (savedCalls.success ? savedCalls.data : (codemodeCalls ?? [])).map((call) =>
    call.status === "running" && (aborted || result)
      ? { ...call, status: "cancelled" as const }
      : call,
  );

  return (
    <div className="rounded-md border bg-card text-card-foreground">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {active ? <Loader2Icon className="animate-spin" /> : <CodeIcon />}
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
          {calls.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Nested tool calls ({calls.length})
              </div>
              {calls.map((call) => (
                <div
                  key={call.id}
                  className="flex min-w-0 items-center justify-between gap-2 text-sm"
                >
                  <span className="truncate" title={call.name}>
                    {call.label}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">{call.durationMs} ms</span>
                    <Badge variant={call.status === "error" ? "destructive" : "secondary"}>
                      {call.status === "running"
                        ? "Running"
                        : call.status === "ok"
                          ? "Complete"
                          : call.status === "cancelled"
                            ? "Cancelled"
                            : "Error"}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <CodePanel
            label="Output"
            value={aborted ? "Tool call aborted." : formatToolResult(result)}
          />
          {images.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1">
              <div className="text-xs font-medium text-muted-foreground">Images</div>
              <div className="flex flex-wrap gap-2">
                {images.map((image, index) => (
                  <ZoomableImage key={`${image.src}:${index}`} src={image.src} alt="Tool result" />
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
    result?.content?.flatMap((part) => {
      if (part.type !== "image") return [];
      const displayPart = part as typeof part & { data?: string; url?: string };
      const src = imageSrc({
        url: displayPart.url,
        data: displayPart.data,
        mimeType: part.mimeType,
      });
      return src ? [{ src }] : [];
    }) ?? []
  );
}
