import { PanelLeftCloseIcon, CalendarClockIcon, ListTodoIcon } from "lucide-react";
import { Link } from "react-router-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { showError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, SessionMetadata, User } from "@carmel-agent/shared";
import { AgentSelector } from "./AgentSelector";
import { SessionList } from "./SessionList";
import { SidebarSessionsToolbar } from "./SidebarSessionsToolbar";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "./sidebar-utils";
import type { ContentView } from "@/lib/shell-route";

export function HarnessSidebar({
  activeUser,
  activeAgent,
  activeSession,
  contentView,
  visibleAgents,
  visibleSessions,
  runningSessionIds,
  runOverrides,
  sidebarOpen,
  sidebarWidth,
  sidebarResizing,
  onClose,
  onOpenSession,
  onStartResize,
  onResetWidth,
  onResizeWidth,
  onOpenImport,
}: {
  activeUser?: User;
  activeAgent?: AgentConfig;
  activeSession?: SessionMetadata;
  contentView: ContentView;
  visibleAgents: AgentConfig[];
  visibleSessions: SessionMetadata[];
  runningSessionIds: Set<string>;
  runOverrides: Record<string, boolean>;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarResizing: boolean;
  onClose: () => void;
  onOpenSession: () => void;
  onStartResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResetWidth: () => void;
  onResizeWidth: (width: number) => void;
  onOpenImport: () => void;
}) {
  const createAgent = useHarnessStore((state) => state.createAgent);
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const createSidebarAgent = async (): Promise<AgentConfig | undefined> => {
    try {
      return await createAgent({
        name: `Agent ${visibleAgents.length + 1}`,
        defaultModelRefId: modelRefs[0]?.id,
      });
    } catch (error) {
      showError("Unable to create agent", error);
      return undefined;
    }
  };

  return (
    /* Two ways to leave: slide out over the content on mobile, collapse the
       column to nothing on desktop. Either way the panel stays mounted at its
       own width so its contents never reflow mid-animation — and the animation
       is dropped entirely while dragging the resize handle, which must track
       the pointer exactly. */
    <aside
      inert={!sidebarOpen}
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex min-h-0 w-[var(--sidebar-width)] max-w-[85vw] flex-col overflow-hidden border-r bg-sidebar shadow-lg lg:static lg:z-auto lg:max-w-none lg:shrink-0 lg:shadow-none",
        sidebarResizing ? "transition-none" : "transition-[transform,width] duration-200 ease-out motion-reduce:transition-none",
        sidebarOpen ? "translate-x-0" : "-translate-x-full lg:w-0 lg:translate-x-0 lg:border-r-0",
      )}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] lg:w-[var(--sidebar-width)] lg:pl-0">
        <div className="flex h-[var(--header-height)] shrink-0 items-center gap-2 px-3">
          <img src="/apple-touch-icon.png" alt="" className="size-6 rounded" draggable={false} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[13px] font-medium">Carmel Agent</h1>
            <p className="text-ui-smaller truncate text-muted-foreground">{activeUser?.email}</p>
          </div>
          <Button size="icon-sm" variant="ghost" title="Collapse sidebar" onClick={onClose}>
            <PanelLeftCloseIcon />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <AgentSelector
            activeAgent={activeAgent}
            visibleAgents={visibleAgents}
            activeUserId={activeUserId}
            modelRefs={modelRefs}
            onCreateAgent={createSidebarAgent}
          />
          {activeAgent ? (
            <nav aria-label="Agent work" className="flex flex-col gap-1">
              <Button asChild variant={contentView === "issues" ? "secondary" : "ghost"} className="justify-start">
                <Link
                  to={`/agents/${activeAgent.id}/issues`}
                  aria-current={contentView === "issues" ? "page" : undefined}
                  onClick={onOpenSession}
                >
                  <ListTodoIcon data-icon="inline-start" />
                  Issues
                </Link>
              </Button>
              <Button asChild variant={contentView === "tasks" ? "secondary" : "ghost"} className="justify-start">
                <Link
                  to={`/agents/${activeAgent.id}/tasks`}
                  aria-current={contentView === "tasks" ? "page" : undefined}
                  onClick={onOpenSession}
                >
                  <CalendarClockIcon data-icon="inline-start" />
                  Tasks
                </Link>
              </Button>
            </nav>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <SidebarSessionsToolbar
              activeAgent={activeAgent}
              onOpenSession={onOpenSession}
              onOpenImport={onOpenImport}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <SessionList
                key={activeAgent?.id}
                sessions={visibleSessions}
                runningSessionIds={runningSessionIds}
                runOverrides={runOverrides}
                activeSessionId={activeSession?.id}
                onOpenSession={onOpenSession}
              />
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        className={cn(
          "absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[var(--ui2)] focus-visible:bg-[var(--ui2)] focus-visible:outline-none",
          sidebarOpen ? "hidden lg:block" : "hidden",
        )}
        onPointerDown={onStartResize}
        onDoubleClick={onResetWidth}
        onKeyDown={(event) => {
          const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
          const edge = event.key === "Home" ? MIN_SIDEBAR_WIDTH : event.key === "End" ? MAX_SIDEBAR_WIDTH : undefined;
          if (!delta && edge === undefined) return;
          event.preventDefault();
          onResizeWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, edge ?? sidebarWidth + delta)));
        }}
      />
    </aside>
  );
}
