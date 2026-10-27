import { AgentSessionsPage } from "./AgentSessionsPage";
import { ConversationSwitcher } from "./shell/ConversationSwitcher";
import { TasksOverview } from "./tasks/TasksOverview";
import { AgentSchedulesPage } from "./AgentSchedulesPage";
import { AgentKnowledgePage } from "./AgentKnowledgePage";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { ResourceError } from "./ResourceFeedback";
import { AgentRequestArea } from "@/components/chat/AgentRequestCard";
import { BrowserRequestCard } from "@/components/chat/BrowserRequestCard";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PiChat } from "@/components/PiChat";
import { NewSessionView } from "@/components/harness/NewSessionView";
import { TaskView } from "@/components/harness/tasks/TaskView";
import { NewTaskView } from "@/components/harness/tasks/NewTaskView";

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
const BrowserPanel = lazy(() =>
  import("./BrowserPanel").then((module) => ({ default: module.BrowserPanel })),
);
import { HarnessSidebar } from "@/components/harness/shell/HarnessSidebar";
import { HarnessHeader } from "@/components/harness/shell/HarnessHeader";
import { ImportSessionsDialog } from "@/components/harness/shell/ImportSessionsDialog";
import { TaskRunBanner } from "@/components/harness/shell/TaskRunBanner";
import { WorkspaceLayout } from "@/components/harness/shell/WorkspaceLayout";
import {
  clampSidebarWidth,
  DESKTOP_SIDEBAR_QUERY,
  getDefaultSidebarOpen,
  getDefaultSidebarWidth,
  resetSidebarWidth,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "@/components/harness/shell/sidebar-utils";
import { agentChangesPath, agentFilesPath } from "@/lib/file-links";
import { isWorkspaceView, workspaceChatPath, type WorkspaceView } from "@/lib/workspace-layout";
import { api } from "@/lib/api";
import { sortSessions } from "@/lib/session-groups";
import {
  canOpenTerminal as canUserOpenTerminal,
  resolveShellRoute,
  type ContentView,
} from "@/lib/shell-route";
import { cn } from "@/lib/utils";
import { showError } from "@/lib/errors";
import { canUserSeeAgent, isListedSession } from "@/store/harness-state";
import { useHarnessStore } from "@/store/harness-store";
import type { GitChangeArea } from "@carmel-agent/shared";

/**
 * The chat path each agent was last on, so leaving for files or the terminal
 * and toggling back returns to that session. Read only by the toggle; the open
 * session is always whatever the URL names.
 */
const lastChatPathByAgent = new Map<string, string>();
const lastWorkspacePaths = new Map<string, Partial<Record<WorkspaceView, string>>>();

export function HarnessShell({
  view = "chat",
  homeView = false,
}: {
  view?: ContentView;
  homeView?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    agentId: routeAgentId,
    sessionId: pathSessionId,
    issueId: routeIssueId,
    "*": routeFilePath,
  } = useParams();
  // One selector per field: the shell re-renders when what it shows changes,
  // not on every store write.
  const userId = useHarnessStore((state) => state.activeUserId);
  const homeResource = useRemoteResource({
    key: `home:${userId}:${routeAgentId}`,
    enabled: Boolean(homeView && routeAgentId),
    load: () => api.ensureHome(routeAgentId!),
  });
  useEffect(() => {
    const session = homeResource.data?.session;
    if (!session) return;
    useHarnessStore.setState((state) => ({
      sessions: [...state.sessions.filter((item) => item.id !== session.id), session],
      sessionDetails: { ...state.sessionDetails, [session.id]: session },
    }));
  }, [homeResource.data]);
  const workspaceKey = `${userId}:${routeAgentId}`;
  const rememberedChatPath = lastChatPathByAgent.get(workspaceKey);
  const backgroundSessionId =
    searchParams.get("chat") ?? rememberedChatPath?.split("/sessions/")[1];
  const routeSessionId =
    view === "chat"
      ? homeView
        ? homeResource.data?.home.sessionId
        : pathSessionId
      : isWorkspaceView(view) && backgroundSessionId !== "new"
        ? backgroundSessionId
        : undefined;
  const activeUser = useHarnessStore((state) =>
    state.users.find((user) => user.id === state.activeUserId),
  );
  const agents = useHarnessStore((state) => state.agents);
  const sessions = useHarnessStore((state) => state.sessions);
  const issues = useHarnessStore((state) => state.issues);
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const providerConfigs = useHarnessStore((state) => state.providerConfigs);
  const lastAgentId = useHarnessStore((state) => state.lastAgentId);
  const sessionDetail = useHarnessStore((state) =>
    routeSessionId ? state.sessionDetails[routeSessionId] : undefined,
  );
  const rememberAgent = useHarnessStore((state) => state.rememberAgent);
  const loadUnlistedSession = useHarnessStore((state) => state.loadUnlistedSession);
  const loadIssues = useHarnessStore((state) => state.loadIssues);
  const [sidebarOpen, setSidebarOpen] = useState(getDefaultSidebarOpen);
  const [taskHeaderTarget, setTaskHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(getDefaultSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [workspaceSplit, setWorkspaceSplit] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [lookedUpSessionId, setLookedUpSessionId] = useState<string>();
  const [serverRunningSessionIds, setServerRunningSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [runOverrides, setRunOverrides] = useState<Record<string, boolean>>({});
  const runOverrideRevision = useRef(0);

  const visibleAgents = useMemo(
    () => agents.filter((agent) => canUserSeeAgent(agent, userId)),
    [agents, userId],
  );
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
  const onNewSessionPage =
    (view === "chat" || isWorkspaceView(view)) &&
    !homeView &&
    (!routeSessionId ||
      (isWorkspaceView(view) &&
        !activeSession &&
        (Boolean(routeSession) || lookedUpSessionId === routeSessionId)));
  /* The open file rides in the route, so a reload — or a shared link — comes
     back to the same file rather than to the top of the workspace. */
  const selectedFilePath = routeFilePath ?? "";
  /* Shown as "not offered" rather than "offered then refused". */
  const canOpenTerminal = Boolean(activeAgent && canUserOpenTerminal(activeAgent, userId));
  const visibleSessions = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            session.userId === userId &&
            session.agentId === activeAgent?.id &&
            isListedSession(session),
        )
        .sort(sortSessions),
    [activeAgent?.id, sessions, userId],
  );
  const visibleIssues = useMemo(
    () => issues.filter((issue) => issue.agentId === activeAgent?.id && issue.userId === userId),
    [activeAgent?.id, issues, userId],
  );
  const activeIssueId = view === "tasks" ? routeIssueId : undefined;
  const activeIssue = visibleIssues.find((issue) => issue.id === activeIssueId);
  const chatPath = activeSession?.home
    ? `/agents/${activeSession.agentId}/home`
    : activeAgent
      ? activeSession
        ? `/agents/${activeAgent.id}/sessions/${activeSession.id}`
        : isWorkspaceView(view)
          ? `/agents/${activeAgent.id}/sessions/new`
          : (lastChatPathByAgent.get(workspaceKey) ?? `/agents/${activeAgent.id}/home`)
      : "/";

  const redirectTo = route.kind === "redirect" ? route.to : undefined;
  useEffect(() => {
    if (redirectTo && redirectTo !== location.pathname) navigate(redirectTo, { replace: true });
  }, [location.pathname, navigate, redirectTo]);

  const activeAgentId = activeAgent?.id;
  const browserOpen = view === "browser" && Boolean(activeAgent?.permissions.bash);
  const legacyBrowser = searchParams.get("browser");
  const browserStatus = useRemoteResource({
    key: `browser:${activeAgentId}`,
    enabled: Boolean(activeAgentId && activeAgent?.permissions.bash),
    load: (signal) => api.browserStatus(activeAgentId!, signal),
    pollInterval: 3000,
  });
  const browserNeedsHelp = Boolean(
    browserStatus.data && browserStatus.data.control.phase !== "agent",
  );
  const openChatSessionId = activeSession?.id;

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
      setRunOverrides((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id, running]) => running && id === openChatSessionId),
        ),
      );
    }
  }, [activity.data, openChatSessionId]);

  const onActiveSessionStreamingChange = useCallback(
    (streaming: boolean, hasStreamed: boolean) => {
      const sessionId = activeSession?.id;
      if (!sessionId || !hasStreamed) return;
      runOverrideRevision.current += 1;
      setRunOverrides((current) => ({ ...current, [sessionId]: streaming }));
    },
    [activeSession?.id],
  );

  useEffect(() => {
    if (activeAgentId) rememberAgent(activeAgentId);
  }, [activeAgentId, rememberAgent]);

  useEffect(() => {
    if (activeAgentId && view === "chat") lastChatPathByAgent.set(workspaceKey, location.pathname);
    else if (activeAgentId && isWorkspaceView(view)) {
      if (activeSessionMetadata)
        lastChatPathByAgent.set(
          workspaceKey,
          `/agents/${activeAgentId}/sessions/${activeSessionMetadata.id}`,
        );
      else if (!routeSessionId)
        lastChatPathByAgent.set(workspaceKey, `/agents/${activeAgentId}/sessions/new`);
    }
  }, [activeAgentId, activeSessionMetadata, location.pathname, routeSessionId, view, workspaceKey]);

  useEffect(() => {
    if (!activeAgentId || !isWorkspaceView(view)) return;
    const paths = lastWorkspacePaths.get(workspaceKey) ?? {};
    const params = new URLSearchParams();
    if (view === "changes" && searchParams.has("area"))
      params.set("area", searchParams.get("area")!);
    paths[view] = `${location.pathname}${params.size ? `?${params}` : ""}`;
    lastWorkspacePaths.set(workspaceKey, paths);

    // Explicitly name the companion conversation so a copied link or reload
    // restores the same workspace, including the new-session composer.
    const invalidChat =
      routeSessionId &&
      !activeSession &&
      (Boolean(routeSession) || lookedUpSessionId === routeSessionId);
    if (!searchParams.has("chat") || invalidChat) {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("chat", invalidChat ? "new" : (routeSessionId ?? "new"));
          return next;
        },
        { replace: true },
      );
    }
  }, [
    activeAgentId,
    activeSession,
    location.pathname,
    lookedUpSessionId,
    routeSession,
    routeSessionId,
    searchParams,
    setSearchParams,
    view,
    workspaceKey,
  ]);

  // Older browser links used a query on the current page. Keep those links
  // working while all four tools now share the same workspace destinations.
  useEffect(() => {
    if (!activeAgentId || !legacyBrowser || !activeAgent?.permissions.bash) return;
    navigate(workspaceChatPath(`/agents/${activeAgentId}/browser`, routeSessionId), {
      replace: true,
    });
  }, [activeAgentId, activeAgent?.permissions.bash, legacyBrowser, navigate, routeSessionId]);

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
    pollInterval: (data) =>
      data?.some((issue) => issue.running || issue.status === "queued")
        ? 4_000
        : view === "tasks"
          ? 30_000
          : false,
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

  /* Tool routes remain addressable; chat names the companion conversation. */
  const showContentView = (next: ContentView) => {
    if (!activeAgent || next === "chat") {
      navigate(chatPath);
      return;
    }
    const path = isWorkspaceView(next)
      ? (lastWorkspacePaths.get(workspaceKey)?.[next] ?? `/agents/${activeAgent.id}/${next}`)
      : `/agents/${activeAgent.id}/${next}`;
    navigate(isWorkspaceView(next) ? workspaceChatPath(path, activeSession?.id) : path);
  };

  const browserRequest =
    browserNeedsHelp && !browserOpen && browserStatus.data ? (
      <BrowserRequestCard
        control={browserStatus.data.control}
        onAction={() => showContentView("browser")}
      />
    ) : undefined;
  const hasChatRequests =
    (view === "chat" || isWorkspaceView(view)) &&
    (onNewSessionPage || Boolean(activeSession && activeAgent && activeModel));

  const openFile = (path: string) => {
    if (!activeAgent) return;
    navigate(workspaceChatPath(agentFilesPath(activeAgent.id, path), activeSession?.id));
  };

  const openChange = (change?: { path: string; area: string }) => {
    if (!activeAgent) return;
    navigate(workspaceChatPath(agentChangesPath(activeAgent.id, change), activeSession?.id));
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
        contentView={view}
        homeView={Boolean(homeView || activeSessionMetadata?.home)}
        visibleAgents={visibleAgents}
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
        onOpenSettings={() => navigate("/settings/models")}
      />

      <section className="flex min-w-0 flex-1 flex-col pr-[var(--safe-right)]">
        <HarnessHeader
          sidebarOpen={sidebarOpen}
          activeAgent={activeAgent}
          activeSession={activeSessionMetadata}
          issueTitle={activeIssueId === "new" ? "New task" : activeIssue?.title}
          taskHeaderRef={activeIssueId && activeIssueId !== "new" ? setTaskHeaderTarget : undefined}
          contentView={view}
          homeView={homeView}
          companionVisible={isWorkspaceView(view) && workspaceSplit}
          conversationSwitcher={
            isWorkspaceView(view) && workspaceSplit ? (
              <ConversationSwitcher
                sessions={visibleSessions}
                activeSessionId={activeSessionMetadata?.id}
                runningSessionIds={serverRunningSessionIds}
                runOverrides={runOverrides}
                onSelect={(selection) => {
                  if (selection === "home") {
                    void api
                      .ensureHome(activeAgent!.id)
                      .then(({ home }) =>
                        navigate(
                          workspaceChatPath(
                            `${location.pathname}${location.search}`,
                            home.sessionId,
                          ),
                        ),
                      )
                      .catch((error) => showError("Unable to open Home", error));
                  } else {
                    navigate(
                      workspaceChatPath(
                        `${location.pathname}${location.search}`,
                        selection === "new" ? undefined : selection.id,
                      ),
                    );
                  }
                }}
              />
            ) : undefined
          }
          canOpenTerminal={canOpenTerminal}
          browserOpen={browserOpen}
          browserNeedsHelp={browserNeedsHelp}
          onToggleBrowser={() => showContentView(browserOpen ? "chat" : "browser")}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onContentViewChange={showContentView}
          onOpenAgentSettings={() => {
            if (!activeAgent) return;
            const section = activeAgent.ownerUserId === userId ? "general" : "archived";
            navigate(`/agents/${activeAgent.id}/settings/${section}`);
          }}
        />
        {homeView && homeResource.error ? (
          <ResourceError
            error={homeResource.error}
            title="Unable to open Home"
            onRetry={homeResource.refresh}
          />
        ) : null}
        {(view === "chat" || isWorkspaceView(view)) && activity.error ? (
          <div className="p-3">
            <ResourceError
              error={activity.error}
              title="Unable to refresh session status"
              onRetry={activity.refresh}
            />
          </div>
        ) : null}
        {activeSessionMetadata?.taskId ? <TaskRunBanner session={activeSessionMetadata} /> : null}
        <WorkspaceLayout
          onSplitChange={setWorkspaceSplit}
          view={isWorkspaceView(view) && activeAgent ? view : undefined}
          legacyMode={legacyBrowser === "full" ? "full" : legacyBrowser ? "split" : undefined}
          onClose={() => showContentView("chat")}
          primary={
            view === "sessions" && activeAgent ? (
              <AgentSessionsPage
                key={activeAgent.id}
                agent={activeAgent}
                sessions={visibleSessions}
                runningSessionIds={serverRunningSessionIds}
                runOverrides={runOverrides}
                onSelectSession={(session) =>
                  navigate(`/agents/${session.agentId}/sessions/${session.id}`)
                }
                onOpenImport={() => setImportDialogOpen(true)}
              />
            ) : view === "knowledge" && activeAgent ? (
              <AgentKnowledgePage key={activeAgent.id} agent={activeAgent} />
            ) : view === "schedules" && activeAgent ? (
              <AgentSchedulesPage key={activeAgent.id} agent={activeAgent} />
            ) : view === "tasks" && activeAgent ? (
              activeIssueId === "new" ? (
                <NewTaskView key={activeAgent.id} agent={activeAgent} />
              ) : activeIssueId ? (
                <TaskView
                  key={activeIssueId}
                  agent={activeAgent}
                  issueId={activeIssueId}
                  headerTarget={taskHeaderTarget}
                  onIssuesChanged={issueList.refresh}
                />
              ) : (
                <TasksOverview
                  key={activeAgent.id}
                  agent={activeAgent}
                  issues={visibleIssues}
                  loading={issueList.loading}
                  error={issueList.error}
                  onRefresh={issueList.refresh}
                />
              )
            ) : onNewSessionPage && activeAgent ? (
              <NewSessionView
                key={activeAgent.id}
                agent={activeAgent}
                browserRequest={browserRequest}
                modelRefs={modelRefs}
                providerConfigs={providerConfigs}
                onOpenSession={(sessionId) => {
                  navigate(
                    isWorkspaceView(view)
                      ? workspaceChatPath(`${location.pathname}${location.search}`, sessionId)
                      : `/agents/${activeAgent.id}/sessions/${sessionId}`,
                  );
                }}
              />
            ) : activeSession && activeAgent && activeModel ? (
              <PiChat
                key={activeSession.id}
                agentConfig={activeAgent}
                browserRequest={browserRequest}
                session={activeSession}
                modelRef={activeModel}
                modelRefs={modelRefs}
                providerConfigs={providerConfigs}
                onStreamingChange={onActiveSessionStreamingChange}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                {route.kind === "empty"
                  ? "Create an agent to start chatting."
                  : "Loading session..."}
              </div>
            )
          }
        >
          <Suspense
            fallback={<div className="p-6 text-sm text-muted-foreground">Loading {view}…</div>}
          >
            {view === "terminal" && canOpenTerminal && activeAgent ? (
              <TerminalPanel key={activeAgent.id} agent={activeAgent} />
            ) : view === "changes" && activeAgent ? (
              <ChangesView
                key={activeAgent.id}
                agent={activeAgent}
                changePath={routeFilePath || undefined}
                area={changeArea(searchParams.get("area"))}
                onOpenChange={openChange}
                onOpenFile={openFile}
              />
            ) : view === "files" && activeAgent ? (
              <>
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
              </>
            ) : browserOpen && activeAgent ? (
              <BrowserPanel key={activeAgent.id} agent={activeAgent} />
            ) : null}
          </Suspense>
        </WorkspaceLayout>
        {!hasChatRequests ? <AgentRequestArea>{browserRequest}</AgentRequestArea> : null}
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
  return value === "staged" ||
    value === "unstaged" ||
    value === "untracked" ||
    value === "conflicted"
    ? value
    : undefined;
}
