import { IssuesOverview } from "./issues/IssuesOverview";
import { AgentTasksPage } from "./AgentTasksPage";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { ResourceError } from "./ResourceFeedback";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
const BrowserPanel = lazy(() => import("./BrowserPanel").then((module) => ({ default: module.BrowserPanel })));
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
} from "@/components/harness/shell/sidebar-utils";
import { agentFilesPath } from "@/lib/file-links";
import { api } from "@/lib/api";
import { sortSessions } from "@/lib/session-groups";
import { canOpenTerminal as canUserOpenTerminal, resolveShellRoute, type ContentView } from "@/lib/shell-route";
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
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    agentId: routeAgentId,
    sessionId: routeSessionId,
    issueId: routeIssueId,
    "*": routeFilePath,
  } = useParams();
  // One selector per field: the shell re-renders when what it shows changes,
  // not on every store write.
  const userId = useHarnessStore((state) => state.activeUserId);
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
  const activeAgent = route.kind === "ready" ? route.agent : undefined;
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
  const chatPath = activeAgent ? (lastChatPathByAgent.get(activeAgent.id) ?? `/agents/${activeAgent.id}`) : "/";

  const redirectTo = route.kind === "redirect" ? route.to : undefined;
  useEffect(() => {
    if (redirectTo && redirectTo !== location.pathname) navigate(redirectTo, { replace: true });
  }, [location.pathname, navigate, redirectTo]);

  const activeAgentId = activeAgent?.id;
  const browserOpen = Boolean(activeAgent?.permissions.bash && searchParams.has("browser"));
  const browserExpanded = searchParams.get("browser") === "full";
  const setBrowserMode = (mode: "split" | "full" | undefined) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (mode) next.set("browser", mode); else next.delete("browser");
      return next;
    }, { replace: true });
  };
  const browserStatus = useRemoteResource({
    key: `browser:${activeAgentId}`,
    enabled: Boolean(activeAgentId && activeAgent?.permissions.bash),
    load: (signal) => api.browserStatus(activeAgentId!, signal),
    pollInterval: 3000,
  });
  const browserNeedsHelp = Boolean(browserStatus.data && browserStatus.data.control.phase !== "agent");
  const openChatSessionId = view === "chat" ? activeSession?.id : undefined;

  const activity = useRemoteResource({
    key: `activity:${activeAgentId}`,
    enabled: Boolean(activeAgentId),
    load: async (signal) => {
      const revision = runOverrideRevision.current;
      const { sessionIds } = await api.listActiveSessions(activeAgentId!, signal);
      return { sessionIds, revision };
    },
    pollInterval: 4_000,
    refreshKey: openChatSessionId,
  });
  useEffect(() => {
    if (!activity.data) return;
    setServerRunningSessionIds(new Set(activity.data.sessionIds));
    if (runOverrideRevision.current === activity.data.revision) {
      setRunOverrides((current) => Object.fromEntries(
        Object.entries(current).filter(([id, running]) => running && id === openChatSessionId),
      ));
    }
  }, [activity.data, openChatSessionId]);

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

  const issueList = useRemoteResource({
    key: `issues:${activeAgentId}`,
    enabled: Boolean(activeAgentId),
    load: (signal) => loadIssues(activeAgentId!, signal),
    refreshKey: view,
    pollInterval: (data) => data?.some((issue) => issue.running || issue.status === "queued")
      ? 4_000 : view === "issues" ? 30_000 : false,
  });

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
        activeUser={activeUser}
        activeAgent={activeAgent}
        activeSession={view === "chat" ? activeSessionMetadata : undefined}
        contentView={view}
        visibleAgents={visibleAgents}
        visibleSessions={visibleSessions}
        runningSessionIds={serverRunningSessionIds}
        runOverrides={runOverrides}
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
        sidebarResizing={sidebarResizing}
        onClose={() => setSidebarOpen(false)}
        onOpenSession={closeSidebarOnMobile}
        onStartResize={startSidebarResize}
        onResetWidth={() => resetSidebarWidth(setSidebarWidth)}
        onResizeWidth={(width) => {
          setSidebarWidth(width);
          window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
        }}
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
          browserOpen={browserOpen}
          browserNeedsHelp={browserNeedsHelp}
          onToggleBrowser={() => setBrowserMode(browserOpen ? undefined : "split")}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onContentViewChange={showContentView}
          onOpenSettings={() => navigate("/settings/models")}
        />
        {view === "chat" && activity.error ? <div className="p-3"><ResourceError error={activity.error} title="Unable to refresh session status" onRetry={activity.refresh} /></div> : null}
        {view === "chat" && activeSessionMetadata?.taskId ? <TaskRunBanner session={activeSessionMetadata} /> : null}
        {browserNeedsHelp && !browserOpen ? <div className="p-3"><Alert role="status"><AlertTitle>Browser assistance</AlertTitle><AlertDescription>{browserStatus.data?.control.reason ?? "Someone is helping in the browser."}<Button size="sm" variant="outline" onClick={() => setBrowserMode("split")}>Open browser</Button></AlertDescription></Alert></div> : null}
        <div className="flex min-h-0 flex-1">
        <div className={cn("min-h-0 min-w-0 flex-1", browserOpen && (browserExpanded ? "hidden" : "hidden lg:block"))}>
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
            <AgentTasksPage key={activeAgent.id} agent={activeAgent} />
          ) : view === "issues" && activeAgent ? (
            activeIssueId === "new" ? <NewIssueView key={activeAgent.id} agent={activeAgent} />
              : activeIssueId ? <IssueView key={activeIssueId} agent={activeAgent} issueId={activeIssueId} onIssuesChanged={issueList.refresh} />
              : <IssuesOverview key={activeAgent.id} agent={activeAgent} issues={visibleIssues} loading={issueList.loading} error={issueList.error} onRefresh={issueList.refresh} />
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
        {browserOpen && activeAgent ? <aside className={cn("min-h-0 min-w-0 border-l", browserExpanded ? "flex-1" : "w-full lg:w-[55%]")}>
          <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading browser…</div>}>
            <BrowserPanel key={activeAgent.id} agent={activeAgent} expanded={browserExpanded} onExpand={() => setBrowserMode(browserExpanded ? "split" : "full")} onClose={() => setBrowserMode(undefined)} />
          </Suspense>
        </aside> : null}
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
