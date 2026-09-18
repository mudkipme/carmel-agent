import { lazy, Suspense, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PiChat } from "@/components/PiChat";
import { NewSessionView } from "@/components/harness/NewSessionView";
import { IssueView } from "@/components/harness/issues/IssueView";
import { NewIssueView } from "@/components/harness/issues/NewIssueView";

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
import { agentFilesPath } from "@/lib/file-links";
import { cn } from "@/lib/utils";
import { isListedSession } from "@/store/harness-state";
import { useHarnessStore } from "@/store/harness-store";

export function HarnessShell({ view = "chat" }: { view?: ContentView }) {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    agentId: routeAgentId,
    sessionId: routeSessionId,
    issueId: routeIssueId,
    "*": routeFilePath,
  } = useParams();
  const store = useHarnessStore();
  const setActiveAgent = store.setActiveAgent;
  const setActiveSession = store.setActiveSession;
  const loadUnlistedSession = store.loadUnlistedSession;
  const loadIssues = store.loadIssues;
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
  /* The chat opens a session only when the URL names one; an agent's own path
     is its new-session composer, whatever session was open before. */
  const onNewSessionPage = view === "chat" && !routeSessionId;
  const activeSessionMetadata =
    !onNewSessionPage && selectedSession?.userId === store.activeUserId && selectedSession.agentId === activeAgent?.id
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
  const visibleIssues = store.issues.filter((issue) => issue.agentId === activeAgent?.id && issue.userId === store.activeUserId);
  /* An issue in the route belongs to the agent in the route; once another agent
     is active, the issues pane falls back to that agent's composer. */
  const activeIssueId = view === "issues" && activeAgent?.id === routeAgentId ? routeIssueId : undefined;
  const activeIssue = visibleIssues.find((issue) => issue.id === activeIssueId);
  const anyIssueRunning = visibleIssues.some((issue) => issue.running);
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
    /* Landing on the composer also lets go of the previous session, so leaving
       for files or the terminal and back returns here rather than to it. */
    if (routeAgent && (store.activeAgentId !== routeAgent.id || (onNewSessionPage && store.activeSessionId))) {
      setActiveAgent(routeAgent.id);
    }
  }, [
    onNewSessionPage,
    routeAgent,
    routeSession,
    routeSessionId,
    setActiveAgent,
    setActiveSession,
    store.activeAgentId,
    store.activeSessionId,
  ]);

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
        ? agentFilesPath(activeAgent.id, selectedFilePath)
        : view === "terminal" && activeAgent && canOpenTerminal
          ? `/agents/${activeAgent.id}/terminal`
          : view === "issues" && activeAgent
            ? `/agents/${activeAgent.id}/issues${activeIssueId ? `/${activeIssueId}` : ""}`
            : onNewSessionPage && activeAgent
              ? `/agents/${activeAgent.id}`
              : chatPath;
    if (location.pathname !== targetPath) {
      navigate(targetPath, { replace: true });
    }
  }, [
    activeAgent,
    activeIssueId,
    canOpenTerminal,
    chatPath,
    location.pathname,
    lookingUpRouteSession,
    navigate,
    onNewSessionPage,
    routeAgent,
    routeAgentId,
    routeSession,
    routeSessionId,
    selectedFilePath,
    store.activeAgentId,
    store.activeSessionId,
    view,
  ]);

  /* Issue runs go on without anyone watching, so their state is polled: often
     while one is running, rarely otherwise. */
  const activeAgentId = activeAgent?.id;
  useEffect(() => {
    if (!activeAgentId) return;
    const load = () => void loadIssues(activeAgentId).catch(() => undefined);
    load();
    const timer = window.setInterval(load, anyIssueRunning ? 4_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [activeAgentId, anyIssueRunning, loadIssues]);

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
    navigate(agentFilesPath(activeAgent.id, path));
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
        activeIssueId={activeIssueId}
        contentView={view}
        visibleAgents={visibleAgents}
        visibleSessions={visibleSessions}
        visibleIssues={visibleIssues}
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
          issueTitle={activeIssue?.title}
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
          ) : view === "issues" && activeAgent ? (
            activeIssueId ? (
              <IssueView
                key={activeIssueId}
                agent={activeAgent}
                issueId={activeIssueId}
                modelRefs={store.modelRefs}
                providerConfigs={store.providerConfigs}
              />
            ) : (
              <NewIssueView
                key={activeAgent.id}
                agent={activeAgent}
                modelRefs={store.modelRefs}
                providerConfigs={store.providerConfigs}
              />
            )
          ) : onNewSessionPage && activeAgent ? (
            <NewSessionView
              key={activeAgent.id}
              agent={activeAgent}
              modelRefs={store.modelRefs}
              providerConfigs={store.providerConfigs}
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
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              {activeAgent ? "Loading session..." : "Create an agent to start chatting."}
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
