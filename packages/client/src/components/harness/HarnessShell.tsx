import { lazy, Suspense, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PiChat } from "@/components/PiChat";

const FileEditorView = lazy(() =>
  import("@/components/harness/files/FileEditorView").then((module) => ({
    default: module.FileEditorView,
  })),
);
const FileManagerView = lazy(() =>
  import("@/components/harness/files/FileManagerView").then((module) => ({
    default: module.FileManagerView,
  })),
);
const TerminalPanel = lazy(() =>
  import("@/components/harness/TerminalPanel").then((module) => ({
    default: module.TerminalPanel,
  })),
);
import { HarnessSidebar } from "@/components/harness/shell/HarnessSidebar";
import { HarnessHeader } from "@/components/harness/shell/HarnessHeader";
import { ImportSessionsDialog } from "@/components/harness/shell/ImportSessionsDialog";
import { TaskRunBanner } from "@/components/harness/shell/TaskRunBanner";
import {
  clampSidebarWidth,
  DESKTOP_SIDEBAR_QUERY,
  getDefaultSidebarOpen,
  getDefaultSidebarWidth,
  resetSidebarWidth,
  SIDEBAR_WIDTH_STORAGE_KEY,
  sortSessions,
  type ContentView,
} from "@/components/harness/shell/sidebar-utils";
import { cn } from "@/lib/utils";
import { isListedSession } from "@/store/harness-state";
import { useHarnessStore } from "@/store/harness-store";

/** Workspace-relative path as URL segments: names carry spaces, #, and ?. */
function encodeFilePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function HarnessShell({ view = "chat" }: { view?: ContentView }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { agentId: routeAgentId, sessionId: routeSessionId, "*": routeFilePath } = useParams();
  const store = useHarnessStore();
  const setActiveAgent = store.setActiveAgent;
  const setActiveSession = store.setActiveSession;
  const loadUnlistedSession = store.loadUnlistedSession;
  const [sidebarOpen, setSidebarOpen] = useState(getDefaultSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(getDefaultSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [routeSessionLookup, setRouteSessionLookup] = useState<{ sessionId: string; done: boolean }>();
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
  const activeSession = activeSessionMetadata
    ? (store.sessionDetails[activeSessionMetadata.id] ?? {
        ...activeSessionMetadata,
        messages: [],
        messageEntryIds: [],
      })
    : undefined;
  const activeModel = store.modelRefs.find((model) => model.id === activeSessionMetadata?.modelRefId);
  /* The open file rides in the route, so a reload — or a shared link — comes
     back to the same file rather than to the top of the workspace. */
  const selectedFilePath = routeFilePath ?? "";
  /* Mirrors the server gate in terminal-socket.ts. Shown as "not offered"
     rather than "offered then refused". */
  const canOpenTerminal = Boolean(
    activeAgent && activeAgent.ownerUserId === store.activeUserId && activeAgent.permissions.bash,
  );
  const visibleSessions = store.sessions
    .filter(
      (session) =>
        session.userId === store.activeUserId && session.agentId === activeAgent?.id && isListedSession(session),
    )
    .slice()
    .sort(sortSessions);
  const routeAgent = routeAgentId ? visibleAgents.find((agent) => agent.id === routeAgentId) : undefined;
  const routeSession = routeSessionId
    ? store.sessions.find((session) => session.id === routeSessionId && session.userId === store.activeUserId)
    : undefined;
  /* A task run's session is not in bootstrap, so a link to one -- or a reload
     while it is open -- has to fetch it before the route can be judged stale. */
  const lookingUpRouteSession = Boolean(
    routeSessionId && !routeSession && !(routeSessionLookup?.sessionId === routeSessionId && routeSessionLookup.done),
  );
  const chatPath = activeSessionMetadata
    ? `/agents/${activeSessionMetadata.agentId}/sessions/${activeSessionMetadata.id}`
    : activeAgent
      ? `/agents/${activeAgent.id}`
      : "/";

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
    if (!routeSessionId || routeSession || routeSessionLookup?.sessionId === routeSessionId) return;
    setRouteSessionLookup({ sessionId: routeSessionId, done: false });
    void loadUnlistedSession(routeSessionId)
      .catch(() => undefined)
      .finally(() => setRouteSessionLookup({ sessionId: routeSessionId, done: true }));
  }, [loadUnlistedSession, routeSession, routeSessionId, routeSessionLookup?.sessionId]);

  useEffect(() => {
    if (lookingUpRouteSession) return;
    if (routeSessionId && routeSession && store.activeSessionId !== routeSession.id) return;
    if (routeAgentId && routeAgent && !routeSessionId && store.activeAgentId !== routeAgent.id) return;

    /* Files and the terminal belong to the agent, not to a session, so they
       hold their own URL for as long as that agent is the active one — an agent
       switch, or a shell this agent may not open, falls back to the chat. */
    const targetPath =
      view === "files" && activeAgent
        ? `/agents/${activeAgent.id}/files${selectedFilePath ? `/${encodeFilePath(selectedFilePath)}` : ""}`
        : view === "terminal" && activeAgent && canOpenTerminal
          ? `/agents/${activeAgent.id}/terminal`
          : chatPath;
    if (location.pathname !== targetPath) {
      navigate(targetPath, { replace: true });
    }
  }, [
    activeAgent,
    canOpenTerminal,
    chatPath,
    location.pathname,
    lookingUpRouteSession,
    navigate,
    routeAgent,
    routeAgentId,
    routeSession,
    routeSessionId,
    selectedFilePath,
    store.activeAgentId,
    store.activeSessionId,
    view,
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

  /* Each pane is a destination of its own, so switching is navigation: the
     file manager and the terminal take the selected session's place instead of
     covering it up. */
  const showContentView = (next: ContentView) => {
    navigate(next !== "chat" && activeAgent ? `/agents/${activeAgent.id}/${next}` : chatPath);
  };

  const openFile = (path: string) => {
    if (!activeAgent) return;
    const filesPath = `/agents/${activeAgent.id}/files`;
    navigate(path ? `${filesPath}/${encodeFilePath(path)}` : filesPath);
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!window.matchMedia(DESKTOP_SIDEBAR_QUERY).matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;
    setSidebarResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const finishResize = () => {
      setSidebarResizing(false);
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
    <main className="relative flex h-[100dvh] min-h-0 overflow-hidden bg-background text-foreground">
      <button
        type="button"
        aria-label="Close sidebar"
        inert={!sidebarOpen}
        className={cn(
          /* visibility rides the same transition so the scrim fades out fully
             before it stops painting its blur. */
          "fixed inset-0 z-20 bg-background/80 backdrop-blur-sm transition-[opacity,visibility] duration-200 motion-reduce:transition-none lg:hidden",
          sidebarOpen ? "visible opacity-100" : "invisible opacity-0",
        )}
        onClick={() => setSidebarOpen(false)}
      />
      <HarnessSidebar
        activeUser={activeUser}
        activeAgent={activeAgent}
        activeSession={view === "chat" ? activeSessionMetadata : undefined}
        visibleAgents={visibleAgents}
        visibleSessions={visibleSessions}
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
        sidebarResizing={sidebarResizing}
        onClose={() => setSidebarOpen(false)}
        onOpenSession={closeSidebarOnMobile}
        onStartResize={startSidebarResize}
        onResetWidth={() => resetSidebarWidth(setSidebarWidth)}
        onOpenImport={() => setImportDialogOpen(true)}
      />

      <section className="flex min-w-0 flex-1 flex-col pr-[var(--safe-right)]">
        <HarnessHeader
          sidebarOpen={sidebarOpen}
          activeAgent={activeAgent}
          activeSession={activeSessionMetadata}
          contentView={view}
          canOpenTerminal={canOpenTerminal}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onContentViewChange={showContentView}
          onOpenSettings={() => navigate("/settings/models")}
        />
        {view === "chat" && activeSessionMetadata?.taskId ? <TaskRunBanner session={activeSessionMetadata} /> : null}
        <div className="min-h-0 flex-1">
          {view === "terminal" && canOpenTerminal && activeAgent ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                  Loading terminal...
                </div>
              }
            >
              {/* Keyed by agent so switching agents attaches to that agent's
                  own shell rather than reusing the mounted one. */}
              <TerminalPanel key={activeAgent.id} agent={activeAgent} />
            </Suspense>
          ) : view === "files" && activeAgent ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                  Loading files...
                </div>
              }
            >
              {/* The manager stays mounted behind the editor, so closing a file
                  lands back in the folder it came from with the selection and
                  the clipboard still there. */}
              <div className={cn("h-full", selectedFilePath && "hidden")}>
                <FileManagerView key={activeAgent.id} agent={activeAgent} onOpenFile={openFile} />
              </div>
              {selectedFilePath ? (
                <FileEditorView
                  key={`${activeAgent.id}:${selectedFilePath}`}
                  agent={activeAgent}
                  filePath={selectedFilePath}
                  onClose={() => openFile("")}
                />
              ) : null}
            </Suspense>
          ) : activeSession && activeAgent && activeModel ? (
            <PiChat
              key={activeSession.id}
              agentConfig={activeAgent}
              session={activeSession}
              modelRef={activeModel}
              modelRefs={store.modelRefs}
              providerConfigs={store.providerConfigs}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              Create a session to start chatting.
            </div>
          )}
        </div>
      </section>
      <ImportSessionsDialog
        open={importDialogOpen}
        activeAgent={activeAgent}
        modelRefs={store.modelRefs}
        onOpenChange={setImportDialogOpen}
        onAfterImport={closeSidebarOnMobile}
      />
    </main>
  );
}
