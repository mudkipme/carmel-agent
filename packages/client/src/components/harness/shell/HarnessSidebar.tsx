import { InboxIcon, PanelLeftCloseIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { IssueList } from "@/components/harness/issues/IssueList";
import { describeIssue, sortIssues } from "@/components/harness/issues/issue-state";
import { Button } from "@/components/ui/button";
import { showError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, Issue, SessionMetadata, User } from "@carmel-agent/shared";
import { AgentSelector } from "./AgentSelector";
import { SessionList } from "./SessionList";
import { SidebarSessionsToolbar } from "./SidebarSessionsToolbar";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, type ContentView, type SidebarList } from "./sidebar-utils";

export function HarnessSidebar({
  unreadActivityCount,
  activeUser,
  activeAgent,
  activeSession,
  activeIssueId,
  contentView,
  visibleAgents,
  visibleSessions,
  runningSessionIds,
  runOverrides,
  visibleIssues,
  sidebarOpen,
  sidebarWidth,
  sidebarResizing,
  onClose,
  onOpenSession,
  onStartResize,
  onResetWidth,
  onOpenImport,
}: {
  unreadActivityCount: number;
  activeUser?: User;
  activeAgent?: AgentConfig;
  activeSession?: SessionMetadata;
  activeIssueId?: string;
  contentView: ContentView;
  visibleAgents: AgentConfig[];
  visibleSessions: SessionMetadata[];
  runningSessionIds: Set<string>;
  runOverrides: Record<string, boolean>;
  visibleIssues: Issue[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarResizing: boolean;
  onClose: () => void;
  onOpenSession: () => void;
  onStartResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResetWidth: () => void;
  onOpenImport: () => void;
}) {
  const createAgent = useHarnessStore((state) => state.createAgent);
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  /* The list follows the main column when it moves between a session and an
     issue, and is otherwise the reader's to switch. */
  const [list, setList] = useState<SidebarList>(contentView === "issues" ? "issues" : "sessions");
  useEffect(() => {
    if (contentView === "issues") setList("issues");
    else if (contentView === "chat") setList("sessions");
  }, [contentView]);
  const attentionCount = visibleIssues.filter((issue) => describeIssue(issue).attention === "blocking").length;

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
          <Button asChild variant={contentView === "inbox" ? "secondary" : "ghost"} className="justify-start">
            <Link to="/inbox" onClick={onOpenSession} aria-current={contentView === "inbox" ? "page" : undefined}>
              <InboxIcon data-icon="inline-start" />Inbox
              {unreadActivityCount > 0 ? <Badge variant="secondary" className="ml-auto" aria-label={`${unreadActivityCount} unread updates`}>{unreadActivityCount}</Badge> : null}
            </Link>
          </Button>
          <AgentSelector
            activeAgent={activeAgent}
            visibleAgents={visibleAgents}
            activeUserId={activeUserId}
            modelRefs={modelRefs}
            onCreateAgent={createSidebarAgent}
          />
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <SidebarSessionsToolbar
              activeAgent={activeAgent}
              list={list}
              attentionCount={attentionCount}
              onListChange={setList}
              onOpenSession={onOpenSession}
              onOpenImport={onOpenImport}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
              {list === "issues" ? (
                <IssueList
                  issues={visibleIssues.slice().sort(sortIssues)}
                  activeIssueId={activeIssueId}
                  onOpenIssue={onOpenSession}
                />
              ) : (
                <SessionList
                  key={activeAgent?.id}
                  sessions={visibleSessions}
                  runningSessionIds={runningSessionIds}
                  runOverrides={runOverrides}
                  activeSessionId={activeSession?.id}
                  onOpenSession={onOpenSession}
                />
              )}
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
