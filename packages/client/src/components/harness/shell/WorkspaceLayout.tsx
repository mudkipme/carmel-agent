import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useElementWidth } from "@/hooks/use-element-width";
import { Maximize2Icon, Columns2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_WORKSPACE_RATIO,
  MIN_PANE_WIDTH,
  MIN_SPLIT_WIDTH,
  WORKSPACE_MODE_KEY,
  WORKSPACE_RATIO_KEY,
  readWorkspacePreference,
  writeWorkspacePreference,
  workspaceWidth,
  type WorkspaceMode,
  type WorkspaceView,
} from "@/lib/workspace-layout";

const LABELS: Record<WorkspaceView, string> = {
  files: /*i18n*/ "Files",
  changes: /*i18n*/ "Changes",
  terminal: /*i18n*/ "Terminal",
  browser: /*i18n*/ "Browser",
};

/** The two content slots stay in place when a pane expands or the window narrows. */
export function WorkspaceLayout({
  view,
  primary,
  children,
  onClose,
  legacyMode,
  onSplitChange,
}: {
  view?: WorkspaceView;
  primary: ReactNode;
  children: ReactNode;
  onClose: () => void;
  legacyMode?: WorkspaceMode;
  onSplitChange: (split: boolean) => void;
}) {
  const { i18n } = useLingui();
  const [host, available] = useElementWidth<HTMLDivElement>();
  const [mode, setMode] = useState<WorkspaceMode>(() =>
    readWorkspacePreference(WORKSPACE_MODE_KEY) === "full" ? "full" : "split",
  );
  const [ratio, setRatio] = useState(() => {
    const stored = Number(readWorkspacePreference(WORKSPACE_RATIO_KEY));
    return stored > 0 && stored < 1 ? stored : DEFAULT_WORKSPACE_RATIO;
  });
  const ratioRef = useRef(ratio);
  const drag = useRef<{ startX: number; width: number; cursor: string; userSelect: string }>(null);
  const [resizing, setResizing] = useState(false);
  const canSplit = available >= MIN_SPLIT_WIDTH;
  const split = Boolean(view && canSplit && mode === "split");
  const width = workspaceWidth(available, ratio);

  useEffect(() => onSplitChange(split), [onSplitChange, split]);

  useEffect(() => {
    if (legacyMode) {
      setMode(legacyMode);
      writeWorkspacePreference(WORKSPACE_MODE_KEY, legacyMode);
    }
  }, [legacyMode]);

  const finishResize = useCallback(() => {
    if (!drag.current) return;
    document.body.style.cursor = drag.current.cursor;
    document.body.style.userSelect = drag.current.userSelect;
    drag.current = null;
    setResizing(false);
    writeWorkspacePreference(WORKSPACE_RATIO_KEY, String(ratioRef.current));
  }, []);
  useEffect(() => finishResize, [finishResize]);
  useEffect(() => {
    if (!split) finishResize();
  }, [finishResize, split]);

  const chooseRatio = (next: number, persist = true) => {
    ratioRef.current = next;
    setRatio(next);
    if (persist) writeWorkspacePreference(WORKSPACE_RATIO_KEY, String(next));
  };

  return (
    <div
      ref={host}
      className="flex min-h-0 min-w-0 flex-1"
      data-workspace-layout={view ? (split ? "split" : "full") : "closed"}
    >
      <section
        id="workspace-conversation"
        className={cn("min-h-0 min-w-0 flex-1", view && !split && "hidden")}
        aria-label={i18n._("Conversation")}
      >
        {primary}
      </section>
      <div className={cn("relative z-10 w-px shrink-0 bg-border", !split && "hidden")}>
        <button
          type="button"
          role="separator"
          aria-label={i18n._("Resize workspace pane")}
          aria-orientation="vertical"
          aria-controls="workspace-conversation workspace-pane"
          aria-valuemin={MIN_PANE_WIDTH}
          aria-valuemax={Math.max(MIN_PANE_WIDTH, available - MIN_PANE_WIDTH - 1)}
          aria-valuenow={width}
          aria-valuetext={i18n._("{width} pixels", { width })}
          className={cn(
            "absolute inset-y-0 -left-1 w-[9px] touch-none cursor-col-resize focus-visible:bg-ring/20 focus-visible:outline-none hover:bg-border/70",
            resizing && "bg-ring/20",
          )}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              startX: event.clientX,
              width,
              cursor: document.body.style.cursor,
              userSelect: document.body.style.userSelect,
            };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            setResizing(true);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            const nextWidth = workspaceWidth(
              available,
              (drag.current.width + drag.current.startX - event.clientX) / available,
            );
            chooseRatio(nextWidth / available, false);
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onDoubleClick={() => chooseRatio(DEFAULT_WORKSPACE_RATIO)}
          onKeyDown={(event) => {
            let next = width;
            if (event.key === "ArrowLeft") next += event.shiftKey ? 50 : 20;
            else if (event.key === "ArrowRight") next -= event.shiftKey ? 50 : 20;
            else if (event.key === "Home") next = MIN_PANE_WIDTH;
            else if (event.key === "End") next = available - MIN_PANE_WIDTH - 1;
            else if (event.key === "Enter") next = available * DEFAULT_WORKSPACE_RATIO;
            else return;
            event.preventDefault();
            chooseRatio(workspaceWidth(available, next / available) / available);
          }}
        />
      </div>
      <section
        id="workspace-pane"
        aria-label={
          view ? i18n._("{view} workspace", { view: i18n._(LABELS[view]) }) : i18n._("Workspace")
        }
        className={cn("flex min-h-0 min-w-0 flex-col", !view && "hidden", !split && "flex-1")}
        style={split ? { width } : undefined}
      >
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
          <span className="truncate text-sm font-medium">
            {view ? i18n._(LABELS[view]) : i18n._("Workspace")}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {canSplit ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  split
                    ? i18n._("Expand {view}", {
                        view: view ? i18n._(LABELS[view]).toLowerCase() : "",
                      })
                    : i18n._("Show beside chat")
                }
                title={split ? i18n._("Use full main area") : i18n._("Show beside chat")}
                onClick={() => {
                  const next = split ? "full" : "split";
                  setMode(next);
                  writeWorkspacePreference(WORKSPACE_MODE_KEY, next);
                }}
              >
                {split ? <Maximize2Icon /> : <Columns2Icon />}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={i18n._("Close workspace")}
              title={i18n._("Back to chat")}
              onClick={onClose}
            >
              <XIcon />
            </Button>
          </div>
        </div>
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
      </section>
    </div>
  );
}
