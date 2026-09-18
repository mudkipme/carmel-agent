import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { AgentSettingsPage } from "@/components/harness/AgentSettingsPage";
import { HarnessShell } from "@/components/harness/HarnessShell";
import { HarnessSkeleton } from "@/components/harness/shell/HarnessSkeleton";
import { LoginScreen } from "@/components/harness/LoginScreen";
import { SetupScreen } from "@/components/harness/SetupScreen";
import { SettingsPage } from "@/components/harness/SettingsPage";
import { Splash } from "@/components/harness/Splash";
import { useHarnessStore } from "@/store/harness-store";

/* Sections are routes, so the page stays mounted — and keeps its unsaved draft —
   while you move between them. That only holds if every entry lands on the same
   route, hence the redirect rather than a second bare-path route. */
function AgentSettingsRedirect() {
  const { agentId } = useParams();
  return <Navigate to={`/agents/${agentId}/settings/general`} replace />;
}

export default function App() {
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
        title="Can't reach Carmel Agent"
        detail={error ?? "We couldn't connect to the server. Check that it's running, then reload this page."}
      />
    );
  }

  if (status === "setup") {
    return <SetupScreen />;
  }

  if (status === "unauthenticated") {
    return <LoginScreen />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HarnessShell />} />
        <Route path="/agents/:agentId" element={<HarnessShell />} />
        <Route path="/agents/:agentId/settings" element={<AgentSettingsRedirect />} />
        <Route path="/agents/:agentId/settings/:section" element={<AgentSettingsPage />} />
        {/* The splat carries the file being edited, and matches the bare
            /files path too, so the manager and the editor share one route. */}
        <Route path="/agents/:agentId/files/*" element={<HarnessShell view="files" />} />
        <Route path="/agents/:agentId/terminal" element={<HarnessShell view="terminal" />} />
        <Route path="/agents/:agentId/sessions/:sessionId" element={<HarnessShell />} />
        {/* Like an agent's own path, the bare issues path is the composer for a new one. */}
        <Route path="/agents/:agentId/issues" element={<HarnessShell view="issues" />} />
        <Route path="/agents/:agentId/issues/:issueId" element={<HarnessShell view="issues" />} />
        <Route path="/settings" element={<Navigate to="/settings/models" replace />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
