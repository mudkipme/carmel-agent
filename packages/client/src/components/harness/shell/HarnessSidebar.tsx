import { PanelLeftCloseIcon } from "lucide-react";
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

export function HarnessSidebar({
  activeUser,
  activeAgent,
  activeSession,
  visibleAgents,
  visibleSessions,
  sidebarOpen,
  sidebarWidth,
  sidebarResizing,
  onClose,
  onOpenSession,
  onStartResize,
  onResetWidth,
  onOpenImport,
}: {
  activeUser?: User;
  activeAgent?: AgentConfig;
  activeSession?: SessionMetadata;
  visibleAgents: AgentConfig[];
  visibleSessions: SessionMetadata[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarResizing: boolean;
  onClose: () => void;
  onOpenSession: () => void;
  onStartResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResetWidth: () => void;
  onOpenImport: () => void;
}) {
  const store = useHarnessStore();

  const createSidebarAgent = async (): Promise<AgentConfig | undefined> => {
    try {
      return await store.createAgent({
        name: `Agent ${visibleAgents.length + 1}`,
        defaultModelRefId: store.modelRefs[0]?.id,
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
            activeUserId={store.activeUserId}
            modelRefs={store.modelRefs}
            onCreateAgent={createSidebarAgent}
          />
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <SidebarSessionsToolbar
              activeAgent={activeAgent}
              onOpenSession={onOpenSession}
              onOpenImport={onOpenImport}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              <SessionList
                sessions={visibleSessions}
                activeSessionId={activeSession?.id}
                onOpenSession={onOpenSession}
              />
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
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
      />
    </aside>
  );
}
