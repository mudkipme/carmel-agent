import { AgentAvatar } from "./AgentAvatar";
import {
  PanelLeftCloseIcon,
  CalendarClockIcon,
  ListTodoIcon,
  SettingsIcon,
  BookOpenIcon,
  HomeIcon,
  MessagesSquareIcon,
  PlusIcon,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";
import type { AgentConfig, User } from "@carmel-agent/shared";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "./sidebar-utils";
import type { ContentView } from "@/lib/shell-route";

export function HarnessSidebar({
  activeUser,
  activeAgent,
  contentView,
  homeView,
  visibleAgents,
  sidebarOpen,
  sidebarWidth,
  sidebarResizing,
  onClose,
  onOpenSession,
  onStartResize,
  onResetWidth,
  onResizeWidth,
  onOpenSettings,
}: {
  activeUser?: User;
  activeAgent?: AgentConfig;
  contentView: ContentView;
  homeView: boolean;
  visibleAgents: AgentConfig[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarResizing: boolean;
  onClose: () => void;
  onOpenSession: () => void;
  onStartResize: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResetWidth: () => void;
  onResizeWidth: (width: number) => void;
  onOpenSettings: () => void;
}) {
  const navigate = useNavigate();
  const createAgent = useHarnessStore((state) => state.createAgent);
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const activeUserId = useHarnessStore((state) => state.activeUserId);
  const homes = useRemoteResource({
    key: `homes:${activeUserId}`,
    enabled: Boolean(activeUserId),
    load: (signal) => api.homeSummaries(signal),
    pollInterval: 3000,
  });
  const knowledge = useRemoteResource({
    key: `knowledge-settings:${activeUserId}:${activeAgent?.id}`,
    enabled: Boolean(activeAgent?.permissions.read),
    load: (signal) => api.knowledgeSettings(activeAgent!.id, signal),
    pollInterval: 30_000,
  });
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
        sidebarResizing
          ? "transition-none"
          : "transition-[transform,width] duration-200 ease-out motion-reduce:transition-none",
        sidebarOpen ? "translate-x-0" : "-translate-x-full lg:w-0 lg:translate-x-0 lg:border-r-0",
      )}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col pt-[var(--safe-top)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] lg:w-[var(--sidebar-width)] lg:pl-0">
        <div className="flex h-[var(--header-height)] shrink-0 items-center gap-2 px-3">
          <img src="/apple-touch-icon.png" alt="" className="size-7 rounded-lg" draggable={false} />
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
            Carmel Agent
          </h1>
          <Button size="icon-sm" variant="ghost" title="Collapse sidebar" onClick={onClose}>
            <PanelLeftCloseIcon />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <nav aria-label="Agents" className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
            {visibleAgents.map((agent) => {
              const selected = agent.id === activeAgent?.id;
              const home = homes.data?.find((item) => item.agentId === agent.id);
              return (
                <div key={agent.id} className="flex flex-col gap-1">
                  <Button
                    asChild
                    variant={selected ? "secondary" : "ghost"}
                    className="justify-start"
                  >
                    <Link to={`/agents/${agent.id}/home`} onClick={onOpenSession}>
                      <AgentAvatar agent={agent} />
                      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                      {home?.needsAttention ? (
                        <span title="Needs your attention" aria-label="Needs your attention">
                          !
                        </span>
                      ) : null}
                      {home?.working ? (
                        <span className="text-muted-foreground" role="status">
                          Working
                        </span>
                      ) : null}
                      {home?.unread ? (
                        <span
                          className="size-2 shrink-0 rounded-full bg-primary"
                          aria-label="Unread messages"
                        />
                      ) : null}
                    </Link>
                  </Button>
                  {selected ? (
                    <nav
                      aria-label="Agent work"
                      className="ml-4 flex flex-col gap-1 border-l pl-2 pb-2"
                    >
                      {[
                        {
                          label: "Home",
                          path: "home",
                          icon: HomeIcon,
                          active: contentView === "chat" && Boolean(homeView),
                        },
                        {
                          label: "Sessions",
                          path: "sessions",
                          icon: MessagesSquareIcon,
                          active:
                            contentView === "sessions" || (contentView === "chat" && !homeView),
                        },
                        {
                          label: "Issues",
                          path: "issues",
                          icon: ListTodoIcon,
                          active: contentView === "issues",
                        },
                        {
                          label: "Tasks",
                          path: "tasks",
                          icon: CalendarClockIcon,
                          active: contentView === "tasks",
                        },
                        ...(agent.permissions.read && knowledge.data?.enabled
                          ? [
                              {
                                label: "Knowledge",
                                path: "knowledge",
                                icon: BookOpenIcon,
                                active: contentView === "knowledge",
                              },
                            ]
                          : []),
                      ].map(({ label, path, icon: Icon, active }) => (
                        <Button
                          key={path}
                          asChild
                          variant={active ? "secondary" : "ghost"}
                          className="justify-start"
                        >
                          <Link
                            to={`/agents/${agent.id}/${path}`}
                            aria-current={active ? "page" : undefined}
                            onClick={onOpenSession}
                          >
                            <Icon data-icon="inline-start" />
                            {label}
                          </Link>
                        </Button>
                      ))}
                    </nav>
                  ) : null}
                </div>
              );
            })}
          </nav>
          <Button
            variant="ghost"
            className="shrink-0 justify-start"
            onClick={() =>
              void createSidebarAgent().then((agent) => {
                if (agent) {
                  navigate(`/agents/${agent.id}/settings/general`);
                  onOpenSession();
                }
              })
            }
          >
            <PlusIcon data-icon="inline-start" />
            New agent
          </Button>
        </div>
        <Separator />
        <footer className="flex shrink-0 items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">{activeUser?.name}</p>
            <p className="text-ui-smaller truncate text-muted-foreground" title={activeUser?.email}>
              {activeUser?.email}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <SettingsIcon />
          </Button>
        </footer>
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
          const edge =
            event.key === "Home"
              ? MIN_SIDEBAR_WIDTH
              : event.key === "End"
                ? MAX_SIDEBAR_WIDTH
                : undefined;
          if (!delta && edge === undefined) return;
          event.preventDefault();
          onResizeWidth(
            Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, edge ?? sidebarWidth + delta)),
          );
        }}
      />
    </aside>
  );
}
