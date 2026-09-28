import { IssuesOverview } from "./issues/IssuesOverview";
import { AgentTasksPanel } from "./AgentTasksPanel";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PiChat } from "@/components/PiChat";
import { NewSessionView } from "@/components/harness/NewSessionView";
import { IssueView } from "@/components/harness/issues/IssueView";
import { NewIssueView } from "@/components/harness/issues/NewIssueView";
import { ActivityInbox } from "@/components/harness/ActivityInbox";
import { useActivityCount } from "@/hooks/use-activity-count";

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
const ChangesView = lazy(() =>
  import("@/components/harness/changes/ChangesView").then((module) => ({
    default: module.ChangesView,
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
  type ContentView,
} from "@/components/harness/shell/sidebar-utils";
import { agentFilesPath } from "@/lib/file-links";
import { api } from "@/lib/api";
import { sortSessions } from "@/lib/session-groups";
import { canOpenTerminal as canUserOpenTerminal, resolveShellRoute } from "@/lib/shell-route";
import { cn } from "@/lib/utils";
import { canUserSeeAgent, isListedSession } from "@/store/harness-state";
import { useHarnessStore } from "@/store/harness-store";
import type { GitChangeArea } from "@carmel-agent/shared";

/**
 * The chat path each agent was last on, so leaving for files or the terminal
 * and toggling back returns to that session. Read only by the toggle; the open
 * session is always whatever the URL names.
 */
const lastChatPathByAgent = new Map<string, string>();

export function HarnessShell({ view = "chat" }: { view?: ContentView }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const {
    agentId: routeAgentId,
    sessionId: routeSessionId,
    issueId: routeIssueId,
    "*": routeFilePath,
  } = useParams();
  // One selector per field: the shell re-renders when what it shows changes,
  // not on every store write.
  const userId = useHarnessStore((state) => state.activeUserId);
  const unreadActivityCount = useActivityCount(userId);
  const activeUser = useHarnessStore((state) => state.users.find((user) => user.id === state.activeUserId));
  const agents = useHarnessStore((state) => state.agents);
  const sessions = useHarnessStore((state) => state.sessions);
  const issues = useHarnessStore((state) => state.issues);
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const providerConfigs = useHarnessStore((state) => state.providerConfigs);
  const lastAgentId = useHarnessStore((state) => state.lastAgentId);
  const sessionDetail = useHarnessStore((state) => (routeSessionId ? state.sessionDetails[routeSessionId] : undefined));
  const rememberAgent = useHarnessStore((state) => state.rememberAgent);
  const loadUnlistedSession = useHarnessStore((state) => state.loadUnlistedSession);
  const loadIssues = useHarnessStore((state) => state.loadIssues);
  const [sidebarOpen, setSidebarOpen] = useState(getDefaultSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(getDefaultSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [lookedUpSessionId, setLookedUpSessionId] = useState<string>();
  const [serverRunningSessionIds, setServerRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [runOverrides, setRunOverrides] = useState<Record<string, boolean>>({});
  const runOverrideRevision = useRef(0);

  const visibleAgents = useMemo(() => agents.filter((agent) => canUserSeeAgent(agent, userId)), [agents, userId]);
  const routeSession = routeSessionId
    ? sessions.find((session) => session.id === routeSessionId && session.userId === userId)
    : undefined;
  const route = resolveShellRoute({
    view,
    routeAgentId,
    routeSessionId,
    agents: visibleAgents,
    lastAgentId,
    routeSession,
    routeSessionLookupDone: lookedUpSessionId === routeSessionId,
    userId,
  });
  const activeAgent = route.kind === "ready" ? route.agent
    : view === "inbox" ? visibleAgents.find((agent) => agent.id === lastAgentId) ?? visibleAgents[0] : undefined;
  const activeSessionMetadata = route.kind === "ready" ? route.session : undefined;
  const activeSession = useMemo(
    () =>
      activeSessionMetadata
        ? (sessionDetail ?? { ...activeSessionMetadata, messages: [], messageEntryIds: [] })
        : undefined,
    [activeSessionMetadata, sessionDetail],
  );
  const activeModel = modelRefs.find((model) => model.id === activeSessionMetadata?.modelRefId);
  const onNewSessionPage = view === "chat" && !routeSessionId;
  /* The open file rides in the route, so a reload — or a shared link — comes
     back to the same file rather than to the top of the workspace. */
  const selectedFilePath = routeFilePath ?? "";
  /* Shown as "not offered" rather than "offered then refused". */
  const canOpenTerminal = Boolean(activeAgent && canUserOpenTerminal(activeAgent, userId));
  const visibleSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.userId === userId && session.agentId === activeAgent?.id && isListedSession(session))
        .sort(sortSessions),
    [activeAgent?.id, sessions, userId],
  );
  const visibleIssues = useMemo(
    () => issues.filter((issue) => issue.agentId === activeAgent?.id && issue.userId === userId),
    [activeAgent?.id, issues, userId],
  );
  const activeIssueId = view === "issues" ? routeIssueId : undefined;
  const activeIssue = visibleIssues.find((issue) => issue.id === activeIssueId);
  const anyIssueRunning = visibleIssues.some((issue) => issue.running);
  const chatPath = activeAgent ? (lastChatPathByAgent.get(activeAgent.id) ?? `/agents/${activeAgent.id}`) : "/";

  const redirectTo = route.kind === "redirect" ? route.to : undefined;
  useEffect(() => {
    if (redirectTo && redirectTo !== location.pathname) navigate(redirectTo, { replace: true });
  }, [location.pathname, navigate, redirectTo]);

  const activeAgentId = activeAgent?.id;
  const openChatSessionId = view === "chat" ? activeSession?.id : undefined;

  useEffect(() => {
    if (!activeAgentId) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const revision = runOverrideRevision.current;
      try {
        const { sessionIds } = await api.listActiveSessions(activeAgentId, controller.signal);
        if (controller.signal.aborted) return;
        setServerRunningSessionIds(new Set(sessionIds));
        if (runOverrideRevision.current === revision) {
          // The open chat knows a prompt has started before the server registers
          // its run. Keep that local signal until the chat reports completion.
          setRunOverrides((current) => Object.fromEntries(
            Object.entries(current).filter(([id, running]) => running && id === openChatSessionId),
          ));
        }
      } catch {
        // Keep the last known status until the next poll succeeds.
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeAgentId, openChatSessionId]);

  const onActiveSessionStreamingChange = useCallback((streaming: boolean, hasStreamed: boolean) => {
    const sessionId = activeSession?.id;
    if (!sessionId || !hasStreamed) return;
    runOverrideRevision.current += 1;
    setRunOverrides((current) => ({ ...current, [sessionId]: streaming }));
  }, [activeSession?.id]);

  useEffect(() => {
    if (activeAgentId) rememberAgent(activeAgentId);
  }, [activeAgentId, rememberAgent]);

  useEffect(() => {
    if (activeAgentId && view === "chat") lastChatPathByAgent.set(activeAgentId, location.pathname);
  }, [activeAgentId, location.pathname, view]);

  /* A task run's or an archived session is not in bootstrap, so a link to one
     -- or a reload while it is open -- has to fetch it before the route can be
     judged stale. */
  useEffect(() => {
    if (!routeSessionId || routeSession || lookedUpSessionId === routeSessionId) return;
    let cancelled = false;
    void loadUnlistedSession(routeSessionId)
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLookedUpSessionId(routeSessionId);
      });
    return () => {
      cancelled = true;
    };
  }, [loadUnlistedSession, lookedUpSessionId, routeSession, routeSessionId]);

  /* Issue runs go on without anyone watching. The list is loaded once per
     agent for the sidebar, then polled only while someone is looking at issues
     or one is running: often while running, otherwise rarely. */
  const pollIssues = view === "issues" || anyIssueRunning;
  useEffect(() => {
    if (!activeAgentId) return;
    void loadIssues(activeAgentId).catch(() => undefined);
  }, [activeAgentId, loadIssues]);
  useEffect(() => {
    if (!activeAgentId || !pollIssues) return;
    const timer = window.setInterval(
      () => void loadIssues(activeAgentId).catch(() => undefined),
      anyIssueRunning ? 4_000 : 30_000,
    );
    return () => window.clearInterval(timer);
  }, [activeAgentId, anyIssueRunning, loadIssues, pollIssues]);

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
    let width = startWidth;
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;
    setSidebarResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const finishResize = () => {
      setSidebarResizing(false);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      // Saved once, when the drag ends, rather than on every pointer move.
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    const resize = (moveEvent: PointerEvent) => {
      width = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      setSidebarWidth(width);
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
        unreadActivityCount={unreadActivityCount}
        activeUser={activeUser}
        activeAgent={activeAgent}
        activeSession={view === "chat" ? activeSessionMetadata : undefined}
        activeIssueId={activeIssueId}
        contentView={view}
        visibleAgents={visibleAgents}
        visibleSessions={visibleSessions}
        runningSessionIds={serverRunningSessionIds}
        runOverrides={runOverrides}
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
          issueTitle={activeIssueId === "new" ? "New issue" : activeIssue?.title}
          contentView={view}
          canOpenTerminal={canOpenTerminal}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onContentViewChange={showContentView}
          onOpenSettings={() => navigate("/settings/models")}
        />
        {view === "chat" && activeSessionMetadata?.taskId ? <TaskRunBanner session={activeSessionMetadata} /> : null}
        <div className="min-h-0 flex-1">
          {view === "inbox" ? (
            <ActivityInbox key={userId} />
          ) : view === "terminal" && canOpenTerminal && activeAgent ? (
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
          ) : view === "changes" && activeAgent ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                  Loading changes...
                </div>
              }
            >
              <ChangesView
                key={activeAgent.id}
                agent={activeAgent}
                changePath={routeFilePath || undefined}
                area={changeArea(searchParams.get("area"))}
              />
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
          ) : view === "tasks" && activeAgent ? (
            <div className="h-full overflow-y-auto p-5"><AgentTasksPanel key={activeAgent.id} agentId={activeAgent.id} /></div>
          ) : view === "issues" && activeAgent ? (
            activeIssueId === "new" ? <NewIssueView key={activeAgent.id} agent={activeAgent} />
              : activeIssueId ? <IssueView key={activeIssueId} agent={activeAgent} issueId={activeIssueId} />
              : <IssuesOverview key={activeAgent.id} agent={activeAgent} issues={visibleIssues} />
          ) : onNewSessionPage && activeAgent ? (
            <NewSessionView
              key={activeAgent.id}
              agent={activeAgent}
              modelRefs={modelRefs}
              providerConfigs={providerConfigs}
            />
          ) : activeSession && activeAgent && activeModel ? (
            <PiChat
              key={activeSession.id}
              agentConfig={activeAgent}
              session={activeSession}
              modelRef={activeModel}
              modelRefs={modelRefs}
              providerConfigs={providerConfigs}
              onStreamingChange={onActiveSessionStreamingChange}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              {route.kind === "empty" ? "Create an agent to start chatting." : "Loading session..."}
            </div>
          )}
        </div>
      </section>
      <ImportSessionsDialog
        open={importDialogOpen}
        activeAgent={activeAgent}
        modelRefs={modelRefs}
        onOpenChange={setImportDialogOpen}
        onAfterImport={closeSidebarOnMobile}
      />
    </main>
  );
}

function changeArea(value: string | null): GitChangeArea | undefined {
  return value === "staged" || value === "unstaged" || value === "untracked" || value === "conflicted" ? value : undefined;
}
