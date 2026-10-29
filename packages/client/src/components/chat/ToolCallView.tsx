import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { NestedToolSlot, CodemodeToolDetails, CodemodeNestedCall } from "@carmel-agent/shared";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CodeIcon,
  FilePenLineIcon,
  FileTextIcon,
  GlobeIcon,
  Loader2Icon,
  SearchIcon,
  TerminalIcon,
  CircleStopIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toolPresentation } from "@/lib/tool-presentation";
import { CodeBlock } from "./CodeBlock";
import { formatJson, formatToolResult, imageSrc } from "./chat-utils";
import { ZoomableImage } from "./ZoomableImage";

type ToolCallViewProps = {
  toolCall: ToolCall;
  result?: ToolResultMessage;
  pending?: boolean;
  streaming?: boolean;
  aborted?: boolean;
  nestedTools?: readonly NestedToolSlot[];
};

export function ToolCallView({
  toolCall,
  result,
  pending = false,
  streaming = false,
  aborted = false,
  nestedTools,
}: ToolCallViewProps) {
  const { i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const isError = result?.isError;
  const state = aborted
    ? i18n._("Stopped")
    : isError
      ? i18n._("Error")
      : result
        ? i18n._("Complete")
        : pending
          ? i18n._("Running")
          : streaming
            ? i18n._("Preparing")
            : i18n._("Pending");
  const active = !aborted && !isError && !result && (streaming || pending);
  const presentation = toolPresentation(toolCall.name, toolCall.arguments);
  const ToolIcon =
    {
      terminal: TerminalIcon,
      read: FileTextIcon,
      edit: FilePenLineIcon,
      search: SearchIcon,
      web: GlobeIcon,
      tool: CodeIcon,
    }[presentation.kind] ?? CodeIcon;
  const images = getToolResultImages(result);
  const calls = (result?.details as CodemodeToolDetails | undefined)?.calls;

  return (
    <div
      className={cn(
        "tool-call overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground",
        isError && "border-destructive/30",
      )}
      data-state={
        aborted
          ? "stopped"
          : isError
            ? "error"
            : result
              ? "complete"
              : pending
                ? "running"
                : streaming
                  ? "preparing"
                  : "pending"
      }
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        className="flex min-h-8 w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        onClick={() => setOpen((value) => !value)}
      >
        <ToolIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate font-medium" title={toolCall.name}>
            {presentation.label}
          </span>
          {presentation.summary ? (
            <span
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
              title={presentation.summary}
            >
              {presentation.summary}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground",
            isError && "text-destructive",
            active && "text-primary",
          )}
        >
          {active ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-3.5 animate-spin motion-reduce:animate-none"
            />
          ) : isError ? (
            <CircleAlertIcon aria-hidden="true" className="size-3.5" />
          ) : aborted ? (
            <CircleStopIcon aria-hidden="true" className="size-3.5" />
          ) : result ? (
            <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
          ) : null}
          <span className={cn(Boolean(result) && !isError && !aborted && "sr-only")}>{state}</span>
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
      {open ? (
        <div
          id={detailsId}
          className="flex flex-col gap-3 border-t border-border/70 bg-muted/30 p-3"
        >
          <div className="break-all font-mono text-xs text-muted-foreground">{toolCall.name}</div>
          <CodePanel
            label={i18n._("Input")}
            value={toolCall.argumentsError ?? formatJson(toolCall.arguments)}
            language={toolCall.argumentsError ? "text" : "json"}
          />
          <NestedCalls
            calls={calls}
            slots={nestedTools ?? []}
            stopped={aborted || Boolean(result)}
          />
          <CodePanel
            label={i18n._("Output")}
            value={aborted ? i18n._("Tool call aborted.") : formatToolResult(result)}
          />
          {images.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1">
              <div className="text-xs font-medium text-muted-foreground">
                <Trans>Images</Trans>
              </div>
              <div className="flex flex-wrap gap-2">
                {images.map((image, index) => (
                  <ZoomableImage
                    key={`${image.src}:${index}`}
                    src={image.src}
                    alt={i18n._("Tool result")}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CodePanel({
  label,
  value,
  language = "text",
}: {
  label: string;
  value: string;
  language?: string;
}) {
  return <CodeBlock label={label} code={value} language={language} />;
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

function NestedCalls({
  calls,
  slots,
  stopped,
}: {
  calls?: CodemodeNestedCall[];
  slots: readonly NestedToolSlot[];
  stopped: boolean;
}) {
  const { i18n } = useLingui();
  if (!calls?.length && !slots.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="text-xs font-medium text-muted-foreground">
        <Trans>Nested tool calls ({calls?.length ?? slots.length})</Trans>
      </div>
      {(calls ?? slots).map((call) => {
        const saved = "id" in call;
        const state = saved
          ? call.status
          : call.status === "done"
            ? !call.summary
              ? "cancelled"
              : call.summary.isError
                ? "error"
                : "ok"
            : stopped
              ? "cancelled"
              : "running";
        const duration = saved ? call.durationMs : call.summary?.durationMs;
        return (
          <div
            key={saved ? call.id : call.callId}
            className="flex min-w-0 items-center justify-between gap-2 text-sm"
          >
            <span className="truncate" title={call.name}>
              {toolPresentation(call.name, {}).label}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {duration !== undefined ? (
                <span className="text-xs text-muted-foreground">{Math.round(duration)} ms</span>
              ) : null}
              <Badge variant={state === "error" ? "destructive" : "secondary"}>
                {state === "running"
                  ? i18n._("Running")
                  : state === "ok"
                    ? i18n._("Complete")
                    : state === "cancelled"
                      ? i18n._("Cancelled")
                      : i18n._("Error")}
              </Badge>
            </span>
          </div>
        );
      })}
    </div>
  );
}
