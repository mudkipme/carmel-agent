import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { AgentRequestArea } from "@/components/chat/AgentRequestCard";
import { BrowserRequestCard } from "@/components/chat/BrowserRequestCard";
import { ResourceError } from "./ResourceFeedback";
import { ConversationSwitcher } from "./shell/ConversationSwitcher";
import { GlobalSearch } from "./shell/GlobalSearch";
import { HarnessHeader } from "./shell/HarnessHeader";
import { HarnessSidebar } from "./shell/HarnessSidebar";
import { ImportSessionsDialog } from "./shell/ImportSessionsDialog";
import { HarnessShellContext, type ShellRouteHandle } from "./shell/shell-context";
import { ShellChatView } from "./shell/ShellViews";
import { TaskRunBanner } from "./shell/TaskRunBanner";
import { useSidebarLayout } from "./shell/use-sidebar-layout";
import { WorkspaceLayout } from "./shell/WorkspaceLayout";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { showError } from "@/lib/errors";
import { agentChangesPath, agentFilesPath } from "@/lib/file-links";
import { sortSessions } from "@/lib/session-groups";
import {
  canOpenTerminal as canUserOpenTerminal,
  resolveShellRoute,
  type ContentView,
} from "@/lib/shell-route";
import { cn } from "@/lib/utils";
import { isWorkspaceView, workspaceChatPath, type WorkspaceView } from "@/lib/workspace-layout";
import { canUserSeeAgent, isListedSession } from "@/store/harness-state";
import { useHarnessStore } from "@/store/harness-store";

/**
 * The chat path each agent was last on, so leaving for files or the terminal
 * and toggling back returns to that session. Read only by the toggle; the open
 * session is always whatever the URL names.
 */
const lastChatPathByAgent = new Map<string, string>();
const lastWorkspacePaths = new Map<string, Partial<Record<WorkspaceView, string>>>();

export function HarnessShell() {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const location = useLocation();
  const matches = useMatches();
  const [searchParams, setSearchParams] = useSearchParams();
  const { agentId: routeAgentId, sessionId: pathSessionId, issueId: routeIssueId } = useParams();

  const routeHandle = [...matches]
    .reverse()
    .map((match) => match.handle as ShellRouteHandle | undefined)
    .find((handle) => handle?.view !== undefined || handle?.homeView !== undefined);
  const view: ContentView = routeHandle?.view ?? "chat";
  const homeView = Boolean(routeHandle?.homeView);

  // One selector per field: the shell re-renders when what it shows changes,
  // not on every store write.
  const userId = useHarnessStore((state) => state.activeUserId);
  const homeResource = useRemoteResource({
    key: `home:${userId}:${routeAgentId}`,
    topics: ["homes"],
    enabled: Boolean(homeView && routeAgentId),
    load: () => api.ensureHome(routeAgentId!),
  });
  const homeSession = homeView ? homeResource.data?.session : undefined;
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
  const modelRefs = useHarnessStore((state) => state.modelRefs);
  const providerConfigs = useHarnessStore((state) => state.providerConfigs);
  const lastAgentId = useHarnessStore((state) => state.lastAgentId);
  const sessionDetail = useHarnessStore((state) =>
    routeSessionId ? state.sessionDetails[routeSessionId] : undefined,
  );
  const rememberAgent = useHarnessStore((state) => state.rememberAgent);
  const loadUnlistedSession = useHarnessStore((state) => state.loadUnlistedSession);

  const sidebar = useSidebarLayout();
  const [searchOpen, setSearchOpen] = useState(false);
  const [taskHeaderTarget, setTaskHeaderTarget] = useState<HTMLDivElement | null>(null);
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLDivElement | null>(null);
  const [issueTitle, setIssueTitle] = useState<string | undefined>(undefined);
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
    ? (sessions.find((session) => session.id === routeSessionId && session.userId === userId) ??
      (homeSession?.id === routeSessionId ? homeSession : undefined))
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
        ? (sessionDetail ??
          (homeSession?.id === activeSessionMetadata.id
            ? homeSession
            : { ...activeSessionMetadata, messages: [], messageEntryIds: [] }))
        : undefined,
    [activeSessionMetadata, homeSession, sessionDetail],
  );
  const activeModel = modelRefs.find((model) => model.id === activeSessionMetadata?.modelRefId);
  const onNewSessionPage =
    (view === "chat" || isWorkspaceView(view)) &&
    !homeView &&
    (!routeSessionId ||
      (isWorkspaceView(view) &&
        !activeSession &&
        (Boolean(routeSession) || lookedUpSessionId === routeSessionId)));
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
  const activeIssueId = view === "tasks" ? routeIssueId : undefined;
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
    topics: ["browser"],
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
    topics: ["sessions"],
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

  /* Tool routes remain addressable; chat names the companion conversation. */
  const showContentView = useCallback(
    (next: ContentView) => {
      if (!activeAgent || next === "chat") {
        navigate(chatPath);
        return;
      }
      const path = isWorkspaceView(next)
        ? (lastWorkspacePaths.get(workspaceKey)?.[next] ?? `/agents/${activeAgent.id}/${next}`)
        : `/agents/${activeAgent.id}/${next}`;
      navigate(isWorkspaceView(next) ? workspaceChatPath(path, activeSession?.id) : path);
    },
    [activeAgent, activeSession?.id, chatPath, navigate, workspaceKey],
  );

  const browserRequest = useMemo(
    () =>
      browserNeedsHelp && !browserOpen && browserStatus.data ? (
        <BrowserRequestCard
          control={browserStatus.data.control}
          onAction={() => showContentView("browser")}
        />
      ) : undefined,
    [browserNeedsHelp, browserOpen, browserStatus.data, showContentView],
  );
  const hasChatRequests =
    (view === "chat" || isWorkspaceView(view)) &&
    (onNewSessionPage || Boolean(activeSession && activeAgent && activeModel));

  const openFile = useCallback(
    (path: string) => {
      if (!activeAgent) return;
      navigate(workspaceChatPath(agentFilesPath(activeAgent.id, path), activeSession?.id));
    },
    [activeAgent, activeSession?.id, navigate],
  );

  const openChange = useCallback(
    (change?: { path: string; area: string }) => {
      if (!activeAgent) return;
      navigate(workspaceChatPath(agentChangesPath(activeAgent.id, change), activeSession?.id));
    },
    [activeAgent, activeSession?.id, navigate],
  );

  const openImportDialog = useCallback(() => setImportDialogOpen(true), []);

  const shellContext = useMemo(
    () => ({
      view,
      homeView,
      route,
      activeAgent,
      activeSession,
      activeModel,
      onNewSessionPage,
      canOpenTerminal,
      browserOpen,
      modelRefs,
      providerConfigs,
      visibleSessions,
      runningSessionIds: serverRunningSessionIds,
      runOverrides,
      browserRequest,
      headerActionsTarget,
      taskHeaderTarget,
      setIssueTitle,
      onActiveSessionStreamingChange,
      onOpenImport: openImportDialog,
      openFile,
      openChange,
    }),
    [
      activeAgent,
      activeModel,
      activeSession,
      browserOpen,
      browserRequest,
      canOpenTerminal,
      headerActionsTarget,
      homeView,
      modelRefs,
      onActiveSessionStreamingChange,
      onNewSessionPage,
      openChange,
      openFile,
      openImportDialog,
      providerConfigs,
      route,
      runOverrides,
      serverRunningSessionIds,
      taskHeaderTarget,
      view,
      visibleSessions,
    ],
  );

  const workspaceRoute = isWorkspaceView(view);
  const chatPrimary = view === "chat" || workspaceRoute;

  return (
    <main className="relative flex h-[100dvh] min-h-0 overflow-hidden bg-background text-foreground">
      <button
        type="button"
        aria-label={i18n._("Close sidebar")}
        inert={!sidebar.sidebarOpen}
        className={cn(
          /* visibility rides the same transition so the scrim fades out fully
             before it stops painting its blur. */
          "fixed inset-0 z-20 bg-background/80 backdrop-blur-sm transition-[opacity,visibility] duration-200 motion-reduce:transition-none lg:hidden",
          sidebar.sidebarOpen ? "visible opacity-100" : "invisible opacity-0",
        )}
        onClick={() => sidebar.setSidebarOpen(false)}
      />
      <GlobalSearch
        key={userId}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        agents={visibleAgents}
        onNavigate={sidebar.closeSidebarOnMobile}
      />
      <HarnessSidebar
        activeUser={activeUser}
        activeAgent={activeAgent}
        contentView={view}
        homeView={Boolean(homeView || activeSessionMetadata?.home)}
        visibleAgents={visibleAgents}
        sidebarOpen={sidebar.sidebarOpen}
        sidebarWidth={sidebar.sidebarWidth}
        sidebarResizing={sidebar.sidebarResizing}
        onClose={() => sidebar.setSidebarOpen(false)}
        onOpenSession={sidebar.closeSidebarOnMobile}
        onStartResize={sidebar.startSidebarResize}
        onResetWidth={sidebar.onResetWidth}
        onResizeWidth={sidebar.onResizeWidth}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={() => navigate("/settings/models")}
      />

      <section className="flex min-w-0 flex-1 flex-col pr-[var(--safe-right)]">
        <HarnessHeader
          sidebarOpen={sidebar.sidebarOpen}
          activeAgent={activeAgent}
          activeSession={activeSessionMetadata}
          issueTitle={view === "tasks" ? issueTitle : undefined}
          taskHeaderRef={activeIssueId && activeIssueId !== "new" ? setTaskHeaderTarget : undefined}
          actionsRef={setHeaderActionsTarget}
          contentView={view}
          homeView={homeView}
          companionVisible={workspaceRoute && workspaceSplit}
          conversationSwitcher={
            workspaceRoute && workspaceSplit ? (
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
                      .catch((error) => showError(i18n._("Unable to open Home"), error));
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
          onToggleSidebar={() => sidebar.setSidebarOpen((open) => !open)}
          onOpenSearch={() => setSearchOpen(true)}
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
            title={i18n._("Unable to open Home")}
            onRetry={homeResource.refresh}
          />
        ) : null}
        {(view === "chat" || workspaceRoute) && activity.error ? (
          <div className="p-3">
            <ResourceError
              error={activity.error}
              title={i18n._("Unable to refresh session status")}
              onRetry={activity.refresh}
            />
          </div>
        ) : null}
        {activeSessionMetadata?.taskId ? <TaskRunBanner session={activeSessionMetadata} /> : null}
        <HarnessShellContext.Provider value={shellContext}>
          <WorkspaceLayout
            onSplitChange={setWorkspaceSplit}
            view={workspaceRoute && activeAgent ? view : undefined}
            legacyMode={legacyBrowser === "full" ? "full" : legacyBrowser ? "split" : undefined}
            onClose={() => showContentView("chat")}
            primary={chatPrimary ? <ShellChatView /> : <Outlet />}
          >
            {workspaceRoute ? <Outlet /> : null}
          </WorkspaceLayout>
        </HarnessShellContext.Provider>
        {!hasChatRequests ? <AgentRequestArea>{browserRequest}</AgentRequestArea> : null}
      </section>
      <ImportSessionsDialog
        open={importDialogOpen}
        activeAgent={activeAgent}
        modelRefs={modelRefs}
        onOpenChange={setImportDialogOpen}
        onAfterImport={sidebar.closeSidebarOnMobile}
      />
    </main>
  );
}
