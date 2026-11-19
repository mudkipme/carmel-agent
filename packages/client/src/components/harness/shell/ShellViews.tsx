import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { GitChangeArea } from "@carmel-agent/shared";
import { PiChat } from "@/components/PiChat";
import { AgentKnowledgePage } from "@/components/harness/AgentKnowledgePage";
import { AgentSchedulesPage } from "@/components/harness/AgentSchedulesPage";
import { AgentSessionsPage } from "@/components/harness/AgentSessionsPage";
import { NewSessionView } from "@/components/harness/NewSessionView";
import { NewTaskView } from "@/components/harness/tasks/NewTaskView";
import { TaskView } from "@/components/harness/tasks/TaskView";
import { TasksOverview } from "@/components/harness/tasks/TasksOverview";
import { useRemoteResource } from "@/hooks/use-remote-resource";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isWorkspaceView, workspaceChatPath } from "@/lib/workspace-layout";
import { useHarnessShell } from "./shell-context";

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
  import("@/components/harness/BrowserPanel").then((module) => ({
    default: module.BrowserPanel,
  })),
);

function WorkspaceSuspense({ view, children }: { view: string; children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-muted-foreground">
          <Trans>Loading {view}…</Trans>
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

export function ShellChatView() {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    view,
    route,
    activeAgent,
    activeSession,
    activeModel,
    onNewSessionPage,
    modelRefs,
    providerConfigs,
    browserRequest,
    headerActionsTarget,
    onActiveSessionStreamingChange,
  } = useHarnessShell();

  if (onNewSessionPage && activeAgent) {
    return (
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
    );
  }

  if (activeSession && activeAgent && activeModel) {
    return (
      <PiChat
        key={activeSession.id}
        agentConfig={activeAgent}
        browserRequest={browserRequest}
        headerActionsTarget={headerActionsTarget}
        session={activeSession}
        modelRef={activeModel}
        modelRefs={modelRefs}
        providerConfigs={providerConfigs}
        onStreamingChange={onActiveSessionStreamingChange}
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
      {route.kind === "empty"
        ? i18n._("Create an agent to start chatting.")
        : i18n._("Loading session...")}
    </div>
  );
}

export function ShellSessionsView() {
  const navigate = useNavigate();
  const {
    activeAgent,
    modelRefs,
    providerConfigs,
    visibleSessions,
    runningSessionIds,
    runOverrides,
    onOpenImport,
  } = useHarnessShell();
  if (!activeAgent) return null;
  return (
    <AgentSessionsPage
      key={activeAgent.id}
      agent={activeAgent}
      modelRefs={modelRefs}
      providerConfigs={providerConfigs}
      sessions={visibleSessions}
      runningSessionIds={runningSessionIds}
      runOverrides={runOverrides}
      onSelectSession={(session) => navigate(`/agents/${session.agentId}/sessions/${session.id}`)}
      onOpenImport={onOpenImport}
    />
  );
}

export function ShellKnowledgeView() {
  const { activeAgent } = useHarnessShell();
  if (!activeAgent) return null;
  return <AgentKnowledgePage key={activeAgent.id} agent={activeAgent} />;
}

export function ShellSchedulesView() {
  const { activeAgent } = useHarnessShell();
  if (!activeAgent) return null;
  return <AgentSchedulesPage key={activeAgent.id} agent={activeAgent} />;
}

export function ShellTasksView() {
  const { i18n } = useLingui();
  const { issueId } = useParams();
  const { activeAgent, taskHeaderTarget, setIssueTitle } = useHarnessShell();
  const activeAgentId = activeAgent?.id;
  const issueList = useRemoteResource({
    key: `issues:${activeAgentId}`,
    enabled: Boolean(activeAgentId),
    load: (signal) => api.listIssues(activeAgentId!, signal),
    topics: ["issues"],
  });
  const issues = issueList.data ?? [];
  const activeIssue = issueId ? issues.find((issue) => issue.id === issueId) : undefined;
  const title = issueId === "new" ? i18n._("New task") : activeIssue?.title;

  useEffect(() => {
    setIssueTitle(title);
    return () => setIssueTitle(undefined);
  }, [setIssueTitle, title]);

  if (!activeAgent) return null;
  if (issueId === "new") return <NewTaskView key={activeAgent.id} agent={activeAgent} />;
  if (issueId) {
    return (
      <TaskView
        key={issueId}
        agent={activeAgent}
        issueId={issueId}
        headerTarget={taskHeaderTarget}
        onIssuesChanged={issueList.refresh}
      />
    );
  }
  return (
    <TasksOverview
      key={activeAgent.id}
      agent={activeAgent}
      issues={issues}
      loading={issueList.loading}
      error={issueList.error}
      onRefresh={issueList.refresh}
    />
  );
}

export function ShellFilesView() {
  const { "*": routeFilePath } = useParams();
  const { activeAgent, openFile } = useHarnessShell();
  if (!activeAgent) return null;
  const selectedFilePath = routeFilePath ?? "";
  return (
    <WorkspaceSuspense view="files">
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
    </WorkspaceSuspense>
  );
}

export function ShellChangesView() {
  const { "*": routeFilePath } = useParams();
  const [searchParams] = useSearchParams();
  const { activeAgent, openChange, openFile } = useHarnessShell();
  if (!activeAgent) return null;
  return (
    <WorkspaceSuspense view="changes">
      <ChangesView
        key={activeAgent.id}
        agent={activeAgent}
        changePath={routeFilePath || undefined}
        area={changeArea(searchParams.get("area"))}
        onOpenChange={openChange}
        onOpenFile={openFile}
      />
    </WorkspaceSuspense>
  );
}

export function ShellTerminalView() {
  const { activeAgent, canOpenTerminal } = useHarnessShell();
  if (!activeAgent || !canOpenTerminal) return null;
  return (
    <WorkspaceSuspense view="terminal">
      <TerminalPanel key={activeAgent.id} agent={activeAgent} />
    </WorkspaceSuspense>
  );
}

export function ShellBrowserView() {
  const { activeAgent, browserOpen } = useHarnessShell();
  if (!activeAgent || !browserOpen) return null;
  return (
    <WorkspaceSuspense view="browser">
      <BrowserPanel key={activeAgent.id} agent={activeAgent} />
    </WorkspaceSuspense>
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
