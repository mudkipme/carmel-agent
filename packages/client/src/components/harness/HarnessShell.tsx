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
import { useHarnessStore } from "@/store/harness-store";

export function HarnessShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { agentId: routeAgentId, sessionId: routeSessionId } = useParams();
  const store = useHarnessStore();
  const setActiveAgent = store.setActiveAgent;
  const setActiveSession = store.setActiveSession;
  const [sidebarOpen, setSidebarOpen] = useState(getDefaultSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(getDefaultSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  /* The chat, the file manager, and the terminal share the main column, so one
     value decides which is mounted rather than a flag per pane. */
  const [contentView, setContentView] = useState<ContentView>("chat");
  const [selectedFile, setSelectedFile] = useState({ agentId: "", path: "" });
  const [importDialogOpen, setImportDialogOpen] = useState(false);
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
  const selectedFilePath = selectedFile.agentId === activeAgent?.id ? selectedFile.path : "";
  /* Mirrors the server gate in terminal-socket.ts. Shown as "not offered"
     rather than "offered then refused". */
  const canOpenTerminal = Boolean(
    activeAgent && activeAgent.ownerUserId === store.activeUserId && activeAgent.permissions.bash,
  );
  const visibleSessions = store.sessions
    .filter((session) => session.userId === store.activeUserId && session.agentId === activeAgent?.id)
    .slice()
    .sort(sortSessions);
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

  const openSessionView = () => {
    setContentView("chat");
    closeSidebarOnMobile();
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
        activeSession={activeSessionMetadata}
        visibleAgents={visibleAgents}
        visibleSessions={visibleSessions}
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
        sidebarResizing={sidebarResizing}
        onClose={() => setSidebarOpen(false)}
        onOpenSession={openSessionView}
        onStartResize={startSidebarResize}
        onResetWidth={() => resetSidebarWidth(setSidebarWidth)}
        onOpenImport={() => setImportDialogOpen(true)}
      />

      <section className="flex min-w-0 flex-1 flex-col pr-[var(--safe-right)]">
        <HarnessHeader
          sidebarOpen={sidebarOpen}
          activeAgent={activeAgent}
          activeSession={activeSessionMetadata}
          contentView={contentView}
          canOpenTerminal={canOpenTerminal}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onContentViewChange={setContentView}
          onOpenSettings={() => navigate("/settings/models")}
        />
        <div className="min-h-0 flex-1">
          {contentView === "terminal" && canOpenTerminal && activeAgent ? (
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
          ) : contentView === "files" && activeAgent ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                  Loading files...
                </div>
              }
            >
              {selectedFilePath ? (
                <FileEditorView
                  key={`${activeAgent.id}:${selectedFilePath}`}
                  agent={activeAgent}
                  filePath={selectedFilePath}
                  onClose={() => setSelectedFilePath("")}
                />
              ) : (
                <FileManagerView
                  key={activeAgent.id}
                  agent={activeAgent}
                  onOpenFile={setSelectedFilePath}
                />
              )}
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
        onAfterImport={openSessionView}
      />
    </main>
  );
}
