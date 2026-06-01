import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PiChat } from "@/components/PiChat";
import { FileEditorView } from "@/components/harness/files/FileEditorView";
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
  type SidebarMode,
} from "@/components/harness/shell/sidebar-utils";
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
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("sessions");
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
  const activeSession = activeSessionMetadata ? store.sessionDetails[activeSessionMetadata.id] : undefined;
  const activeModel = store.modelRefs.find((model) => model.id === activeSessionMetadata?.modelRefId);
  const selectedFilePath = selectedFile.agentId === activeAgent?.id ? selectedFile.path : "";
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
    <main className="relative flex h-[100dvh] min-h-0 overflow-hidden bg-background text-foreground">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-20 bg-background/80 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <HarnessSidebar
        activeUser={activeUser}
        activeAgent={activeAgent}
        activeSession={activeSessionMetadata}
        visibleAgents={visibleAgents}
        visibleSessions={visibleSessions}
        selectedFilePath={selectedFilePath}
        sidebarMode={sidebarMode}
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
        onClose={() => setSidebarOpen(false)}
        onSidebarModeChange={setSidebarMode}
        onOpenFile={setSelectedFilePath}
        onAfterOpen={closeSidebarOnMobile}
        onStartResize={startSidebarResize}
        onResetWidth={() => resetSidebarWidth(setSidebarWidth)}
        onOpenImport={() => setImportDialogOpen(true)}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <HarnessHeader
          sidebarOpen={sidebarOpen}
          activeAgent={activeAgent}
          activeModel={activeModel}
          activeSession={activeSessionMetadata}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onOpenSettings={() => navigate("/settings/models")}
        />
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
      <ImportSessionsDialog
        open={importDialogOpen}
        activeAgent={activeAgent}
        modelRefs={store.modelRefs}
        onOpenChange={setImportDialogOpen}
        onSidebarModeChange={setSidebarMode}
        onAfterImport={closeSidebarOnMobile}
      />
    </main>
  );
}
