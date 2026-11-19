import { useLingui } from "@lingui/react";
import { SubtaskRedirect } from "@/components/harness/SubtaskRedirect";
import { useEffect } from "react";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Route,
  RouterProvider,
  useParams,
  useLocation,
} from "react-router-dom";
import { AgentSettingsPage } from "@/components/harness/AgentSettingsPage";
import { HarnessShell } from "@/components/harness/HarnessShell";
import { HarnessSkeleton } from "@/components/harness/shell/HarnessSkeleton";
import {
  ShellBrowserView,
  ShellChangesView,
  ShellFilesView,
  ShellKnowledgeView,
  ShellSchedulesView,
  ShellSessionsView,
  ShellTasksView,
  ShellTerminalView,
} from "@/components/harness/shell/ShellViews";
import { LoginScreen } from "@/components/harness/LoginScreen";
import { SetupScreen } from "@/components/harness/SetupScreen";
import { SettingsPage } from "@/components/harness/SettingsPage";
import { Splash } from "@/components/harness/Splash";
import { useHarnessStore } from "@/store/harness-store";
import { useWorkspaceUpdates } from "@/hooks/use-workspace-updates";

/* Sections are routes, so the page stays mounted — and keeps its unsaved draft —
   while you move between them. That only holds if every entry lands on the same
   route, hence the redirect rather than a second bare-path route. */
function AgentSettingsRedirect() {
  const { agentId } = useParams();
  return <Navigate to={`/agents/${agentId}/settings/general`} replace />;
}

function AgentHomeRedirect() {
  const { agentId } = useParams();
  return <Navigate to={`/agents/${agentId}/home`} replace />;
}

function AgentTasksRedirect() {
  const { agentId } = useParams();
  return <Navigate to={`/agents/${agentId}/schedules`} replace />;
}

function LegacyIssueRedirect() {
  const location = useLocation();
  return (
    <Navigate to={`${location.pathname.replace("/issues", "/tasks")}${location.search}`} replace />
  );
}

function TasksRoute() {
  const location = useLocation();
  const { agentId } = useParams();
  if (new URLSearchParams(location.search).has("task"))
    return <Navigate to={`/agents/${agentId}/schedules${location.search}`} replace />;
  return <ShellTasksView />;
}

export default function App() {
  useWorkspaceUpdates();
  const { i18n } = useLingui();
  const status = useHarnessStore((state) => state.status);
  const error = useHarnessStore((state) => state.error);
  const bootstrap = useHarnessStore((state) => state.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const isStandalone = () =>
      standaloneQuery.matches ||
      ("standalone" in window.navigator &&
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
    const preventStandaloneZoom = (event: Event) => {
      if (isStandalone()) event.preventDefault();
    };
    const preventStandalonePinch = (event: TouchEvent) => {
      if (isStandalone() && event.touches.length > 1) event.preventDefault();
    };

    document.addEventListener("gesturestart", preventStandaloneZoom, { passive: false });
    document.addEventListener("gesturechange", preventStandaloneZoom, { passive: false });
    document.addEventListener("gestureend", preventStandaloneZoom, { passive: false });
    document.addEventListener("touchmove", preventStandalonePinch, { passive: false });

    return () => {
      document.removeEventListener("gesturestart", preventStandaloneZoom);
      document.removeEventListener("gesturechange", preventStandaloneZoom);
      document.removeEventListener("gestureend", preventStandaloneZoom);
      document.removeEventListener("touchmove", preventStandalonePinch);
    };
  }, []);

  if (status === "loading" || status === "idle") {
    return <HarnessSkeleton />;
  }

  if (status === "error") {
    return (
      <Splash
        title={i18n._("Can't reach Carmel Agent")}
        detail={
          error ??
          i18n._(
            "We couldn't connect to the server. Check that it's running, then reload this page.",
          )
        }
      />
    );
  }

  if (status === "setup") {
    return <SetupScreen />;
  }

  if (status === "unauthenticated") {
    return <LoginScreen />;
  }

  return <RouterProvider router={router} />;
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route element={<HarnessShell />}>
        <Route path="/" handle={{ view: "chat" }} element={null} />
        <Route
          path="/agents/:agentId/home"
          handle={{ view: "chat", homeView: true }}
          element={null}
        />
        {/* The splat carries the file being edited, and matches the bare
            /files path too, so the manager and the editor share one route. */}
        <Route
          path="/agents/:agentId/files/*"
          handle={{ view: "files" }}
          element={<ShellFilesView />}
        />
        {/* Like files, the splat is the open file: here, the one whose diff shows. */}
        <Route
          path="/agents/:agentId/changes/*"
          handle={{ view: "changes" }}
          element={<ShellChangesView />}
        />
        <Route
          path="/agents/:agentId/terminal"
          handle={{ view: "terminal" }}
          element={<ShellTerminalView />}
        />
        <Route
          path="/agents/:agentId/browser"
          handle={{ view: "browser" }}
          element={<ShellBrowserView />}
        />
        <Route
          path="/agents/:agentId/sessions"
          handle={{ view: "sessions" }}
          element={<ShellSessionsView />}
        />
        <Route path="/agents/:agentId/sessions/new" handle={{ view: "chat" }} element={null} />
        <Route
          path="/agents/:agentId/sessions/:sessionId"
          handle={{ view: "chat" }}
          element={null}
        />
        <Route
          path="/agents/:agentId/schedules"
          handle={{ view: "schedules" }}
          element={<ShellSchedulesView />}
        />
        <Route
          path="/agents/:agentId/knowledge"
          handle={{ view: "knowledge" }}
          element={<ShellKnowledgeView />}
        />
        <Route path="/agents/:agentId/tasks" handle={{ view: "tasks" }} element={<TasksRoute />} />
        <Route
          path="/agents/:agentId/tasks/:issueId"
          handle={{ view: "tasks" }}
          element={<ShellTasksView />}
        />
      </Route>
      <Route path="/agents/:agentId" element={<AgentHomeRedirect />} />
      <Route path="/agents/:agentId/settings" element={<AgentSettingsRedirect />} />
      <Route path="/agents/:agentId/settings/schedules" element={<AgentTasksRedirect />} />
      <Route path="/agents/:agentId/settings/tasks" element={<AgentTasksRedirect />} />
      <Route path="/agents/:agentId/settings/:section" element={<AgentSettingsPage />} />
      <Route
        path="/agents/:agentId/sessions/:sessionId/helpers/:helperId"
        element={<SubtaskRedirect />}
      />
      <Route path="/agents/:agentId/issues" element={<LegacyIssueRedirect />} />
      <Route path="/agents/:agentId/issues/:issueId" element={<LegacyIssueRedirect />} />
      <Route path="/settings" element={<Navigate to="/settings/models" replace />} />
      <Route path="/settings/:section" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </>,
  ),
);
