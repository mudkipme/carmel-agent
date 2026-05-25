import {
  BotIcon,
  EllipsisIcon,
  MessageSquarePlusIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PencilIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PiChat } from "@/components/PiChat";
import { AgentSettingsDialog } from "@/components/harness/AgentSettingsDialog";
import { FileEditorView } from "@/components/harness/files/FileEditorView";
import { FileExplorerPanel } from "@/components/harness/files/FileExplorerPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useHarnessStore } from "@/store/harness-store";

const DESKTOP_SIDEBAR_QUERY = "(min-width: 1024px)";
const SIDEBAR_WIDTH_STORAGE_KEY = "carmel-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 298;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 520;
type SidebarMode = "sessions" | "files";

function getDefaultSidebarOpen() {
  return typeof window === "undefined" ? true : window.matchMedia(DESKTOP_SIDEBAR_QUERY).matches;
}

function getDefaultSidebarWidth() {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;
  const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  return storedWidth ? clampSidebarWidth(Number(storedWidth)) : DEFAULT_SIDEBAR_WIDTH;
}

function clampSidebarWidth(width: number) {
  return Number.isFinite(width)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
    : DEFAULT_SIDEBAR_WIDTH;
}

export function HarnessShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { agentId: routeAgentId, sessionId: routeSessionId } = useParams();
  const store = useHarnessStore();
  const setActiveAgent = store.setActiveAgent;
  const setActiveSession = store.setActiveSession;
  const [sidebarOpen, setSidebarOpen] = useState(getDefaultSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(getDefaultSidebarWidth);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("sessions");
  const [selectedFile, setSelectedFile] = useState({ agentId: "", path: "" });
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const activeUser = store.users.find((user) => user.id === store.activeUserId);
  const selectedSession = store.sessions.find(
    (session) => session.id === store.activeSessionId && session.userId === store.activeUserId,
  );
  const visibleAgents = store.agents.filter((agent) => agent.shared || agent.ownerUserId === store.activeUserId);
  const selectedAgent = visibleAgents.find((agent) => agent.id === store.activeAgentId);
  const activeAgent = selectedAgent ?? visibleAgents.find((agent) => agent.id === selectedSession?.agentId);
  const activeSessionMetadata =
    selectedSession?.userId === store.activeUserId && selectedSession.agentId === activeAgent?.id
      ? selectedSession
      : undefined;
  const activeSession = activeSessionMetadata ? store.sessionDetails[activeSessionMetadata.id] : undefined;
  const activeModel = store.modelRefs.find((model) => model.id === activeSessionMetadata?.modelRefId);
  const selectedFilePath = selectedFile.agentId === activeAgent?.id ? selectedFile.path : "";
  const visibleSessions = store.sessions
    .filter((session) => session.userId === store.activeUserId && session.agentId === activeAgent?.id)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const routeAgent = routeAgentId ? visibleAgents.find((agent) => agent.id === routeAgentId) : undefined;
  const routeSession = routeSessionId
    ? store.sessions.find((session) => session.id === routeSessionId && session.userId === store.activeUserId)
    : undefined;

  useEffect(() => {
    if (routeSessionId) {
      if (routeSession && store.activeSessionId !== routeSession.id) {
        setActiveSession(routeSession.id);
      }
      return;
    }
    if (routeAgent && store.activeAgentId !== routeAgent.id) {
      setActiveAgent(routeAgent.id);
    }
  }, [routeAgent, routeSession, routeSessionId, setActiveAgent, setActiveSession, store.activeAgentId, store.activeSessionId]);

  useEffect(() => {
    if (routeSessionId && routeSession && store.activeSessionId !== routeSession.id) return;
    if (routeAgentId && routeAgent && !routeSessionId && store.activeAgentId !== routeAgent.id) return;

    const targetPath = activeSessionMetadata
      ? `/agents/${activeSessionMetadata.agentId}/sessions/${activeSessionMetadata.id}`
      : activeAgent
        ? `/agents/${activeAgent.id}`
        : "/";
    if (location.pathname !== targetPath) {
      navigate(targetPath, { replace: true });
    }
  }, [
    activeAgent,
    activeSessionMetadata,
    location.pathname,
    navigate,
    routeAgent,
    routeAgentId,
    routeSession,
    routeSessionId,
    store.activeAgentId,
    store.activeSessionId,
  ]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DESKTOP_SIDEBAR_QUERY);
    const syncSidebarDefault = () => setSidebarOpen(mediaQuery.matches);
    syncSidebarDefault();
    mediaQuery.addEventListener("change", syncSidebarDefault);
    return () => mediaQuery.removeEventListener("change", syncSidebarDefault);
  }, []);

  const closeSidebarOnMobile = () => {
    if (!window.matchMedia(DESKTOP_SIDEBAR_QUERY).matches) setSidebarOpen(false);
  };

  const setSelectedFilePath = (path: string) => {
    setSelectedFile({ agentId: activeAgent?.id ?? "", path });
  };

  const createSidebarAgent = async () => {
    try {
      await store.createAgent({
        name: `Agent ${visibleAgents.length + 1}`,
        defaultModelRefId: store.modelRefs[0]?.id,
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to create agent");
    }
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!window.matchMedia(DESKTOP_SIDEBAR_QUERY).matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const finishResize = () => {
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    const resize = (moveEvent: PointerEvent) => {
      const nextWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      setSidebarWidth(nextWidth);
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  };

  return (
    <main className="relative flex h-screen min-h-0 overflow-hidden bg-background text-foreground">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-20 bg-background/80 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex min-h-0 flex-col border-r bg-muted/50 shadow-lg transition-transform duration-200 lg:static lg:z-auto lg:shrink-0 lg:shadow-none",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:hidden",
        )}
        style={{ width: sidebarWidth }}
      >
        <div className="flex h-11 items-center gap-2 border-b px-3">
          <img src="/favicon.svg" alt="" className="size-7 rounded-md" draggable={false} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[13px] font-medium">Carmel Agent</h1>
            <p className="truncate text-xs text-muted-foreground">{activeUser?.email}</p>
          </div>
          <Button size="icon-sm" variant="ghost" title="Collapse sidebar" onClick={() => setSidebarOpen(false)}>
            <PanelLeftCloseIcon />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <section className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-normal text-muted-foreground">Agent</h2>
              <Badge variant="secondary">{visibleAgents.length}</Badge>
            </div>
            <div className="flex items-center gap-1">
              <Select
                value={activeAgent?.id}
                disabled={!visibleAgents.length}
                onValueChange={(agentId) => {
                  store.setActiveAgent(agentId);
                  navigate(`/agents/${agentId}`);
                }}
              >
                <SelectTrigger className="h-8 min-w-0 flex-1 bg-background px-2 text-[13px]">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent className="max-w-[280px]">
                  <SelectGroup>
                    {visibleAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{agent.name}</span>
                          {agent.shared ? (
                            <Badge variant="secondary" className="shrink-0">
                              Shared
                            </Badge>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {activeAgent?.ownerUserId === store.activeUserId ? (
                <AgentSettingsDialog
                  agent={activeAgent}
                  modelRefs={store.modelRefs}
                  providerConfigs={store.providerConfigs}
                  triggerClassName="opacity-100"
                />
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!store.modelRefs.length}
                onClick={() => void createSidebarAgent()}
                title="New agent"
              >
                <BotIcon />
              </Button>
            </div>
          </section>

          <Tabs
            value={sidebarMode}
            onValueChange={(value) => setSidebarMode(value as SidebarMode)}
            className="flex min-h-0 flex-1 flex-col gap-2"
          >
            <div className="flex items-center gap-2 px-2">
              <TabsList className="grid h-8 flex-1 grid-cols-2">
                <TabsTrigger value="sessions" className="text-xs">
                  Sessions
                </TabsTrigger>
                <TabsTrigger value="files" className="text-xs">
                  Files
                </TabsTrigger>
              </TabsList>
              <Button
                size="icon-sm"
                variant="ghost"
                title="New session"
                onClick={() => {
                  if (!activeAgent) return;
                  void store.createSession({
                    agentId: activeAgent.id,
                    modelRefId: activeAgent.defaultModelRefId,
                    thinkingLevel: activeAgent.defaultThinkingLevel ?? "off",
                  }).then((session) => {
                    navigate(`/agents/${session.agentId}/sessions/${session.id}`);
                  });
                  setSidebarMode("sessions");
                  closeSidebarOnMobile();
                }}
              >
                <MessageSquarePlusIcon />
              </Button>
            </div>
            <TabsContent value="sessions" className="min-h-0 flex-1 overflow-hidden">
              <div className="flex h-full min-h-0 flex-col overflow-auto">
                {visibleSessions.map((session) => (
                  <div
                    key={session.id}
                    className={cn(
                      "group flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 transition-colors hover:bg-accent hover:text-accent-foreground",
                      session.id === activeSessionMetadata?.id && "bg-accent text-accent-foreground",
                    )}
                  >
                    <button
                      className="flex h-full min-w-0 flex-1 items-center text-left"
                      onClick={() => {
                        store.setActiveSession(session.id);
                        navigate(`/agents/${session.agentId}/sessions/${session.id}`);
                        setSidebarMode("sessions");
                        closeSidebarOnMobile();
                      }}
                    >
                      <span className="sr-only">Open session</span>
                      <span className="truncate text-[13px]">{session.title}</span>
                    </button>
                    <div className="relative flex h-full w-8 shrink-0 items-center justify-end">
                      <span
                        className={cn(
                          "text-xs text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
                          openSessionMenuId === session.id && "opacity-0",
                        )}
                      >
                        {formatRelativeTime(session.updatedAt)}
                      </span>
                      <DropdownMenu
                        open={openSessionMenuId === session.id}
                        onOpenChange={(open) => setOpenSessionMenuId(open ? session.id : null)}
                      >
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            title="Session actions"
                            className="absolute right-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
                          >
                            <EllipsisIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() => {
                                const nextTitle = window.prompt("Rename session", session.title);
                                const title = nextTitle?.trim();
                                if (!title || title === session.title) return;
                                void store.updateSession(session.id, { title });
                              }}
                            >
                              <PencilIcon />
                              Rename
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                          <DropdownMenuSeparator />
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => {
                                const confirmed = window.confirm(`Delete "${session.title}"?`);
                                if (!confirmed) return;
                                void store.deleteSession(session.id);
                              }}
                            >
                              <Trash2Icon />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>
            <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden">
              <FileExplorerPanel
                key={activeAgent?.id ?? "no-agent"}
                agent={activeAgent}
                selectedFilePath={selectedFilePath}
                onOpenFile={setSelectedFilePath}
                onAfterOpen={closeSidebarOnMobile}
              />
            </TabsContent>
          </Tabs>
        </div>
        <button
          type="button"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          className="absolute inset-y-0 right-[-3px] hidden w-2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-border/80 focus-visible:bg-border/80 focus-visible:outline-none lg:block"
          onPointerDown={startSidebarResize}
          onDoubleClick={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
            window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(DEFAULT_SIDEBAR_WIDTH));
          }}
        />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 items-center justify-between gap-3 border-b bg-background px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              title={sidebarOpen ? "Collapse sidebar" : "Show sidebar"}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <PanelLeftIcon />
            </Button>
            <div className="min-w-0">
              <h2 className="truncate text-[13px] font-medium">{activeSessionMetadata?.title ?? "No session"}</h2>
              <p className="truncate text-xs text-muted-foreground">
                {activeAgent?.workingDir ?? "No working directory"} · {activeModel?.label ?? "No model"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary">{activeSessionMetadata?.thinkingLevel ?? "off"}</Badge>
            <Badge variant="secondary">{activeAgent?.permissions.bash ? "bash on" : "bash off"}</Badge>
            <Button variant="outline" size="icon-sm" title="Settings" onClick={() => navigate("/settings/models")}>
              <SettingsIcon />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          {sidebarMode === "files" ? (
            <FileEditorView
              key={`${activeAgent?.id ?? "no-agent"}:${selectedFilePath}`}
              agent={activeAgent}
              filePath={selectedFilePath}
            />
          ) : activeSession && activeAgent && activeModel ? (
            <PiChat
              key={activeSession.id}
              agentConfig={activeAgent}
              session={activeSession}
              modelRef={activeModel}
              modelRefs={store.modelRefs}
              providerConfigs={store.providerConfigs}
            />
          ) : activeSessionMetadata && activeAgent && activeModel ? (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              Loading session...
            </div>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              Create a session to start chatting.
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
