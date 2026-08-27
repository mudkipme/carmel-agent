import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { HarnessShell } from "@/components/harness/HarnessShell";
import { HarnessSkeleton } from "@/components/harness/shell/HarnessSkeleton";
import { LoginScreen } from "@/components/harness/LoginScreen";
import { SetupScreen } from "@/components/harness/SetupScreen";
import { SettingsPage } from "@/components/harness/SettingsPage";
import { Splash } from "@/components/harness/Splash";
import { useHarnessStore } from "@/store/harness-store";

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
        <Route path="/agents/:agentId/sessions/:sessionId" element={<HarnessShell />} />
        <Route path="/settings" element={<Navigate to="/settings/models" replace />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
