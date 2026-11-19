import { useEffect } from "react";
import { api, ApiError } from "@/lib/api";
import { clearResourceCache } from "@/lib/resource-cache";
import { createResourceLoader } from "@/lib/resource-loader";
import { updateConnection } from "@/lib/update-connection";
import { resolveBootstrapState, resolveSessionList, resetState } from "@/store/harness-state";
import { useHarnessStore } from "@/store/harness-store";

export function useWorkspaceUpdates() {
  const status = useHarnessStore((state) => state.status);
  const userId = useHarnessStore((state) => state.activeUserId);
  useEffect(() => {
    if (status !== "ready") return;
    const current = () => {
      const state = useHarnessStore.getState();
      return state.activeUserId === userId && state.status === "ready" ? state : undefined;
    };
    const signedOut = (error: unknown) => {
      if (!(error instanceof ApiError && error.status === 401)) return;
      clearResourceCache();
      useHarnessStore.setState((state) => resetState({ status: "unauthenticated" }, state));
    };
    const workspace = createResourceLoader(
      () => api.bootstrap(),
      (result) => {
        const state = current();
        if (!state) return;
        if ("error" in result) signedOut(result.error);
        else useHarnessStore.setState(resolveBootstrapState(result.data, state));
      },
    );
    const sessions = createResourceLoader(
      (signal) => api.listSessions(signal),
      (result) => {
        const state = current();
        if (!state) return;
        if ("error" in result) signedOut(result.error);
        else useHarnessStore.setState(resolveSessionList(result.data, state));
      },
    );
    const unsubscribeWorkspace = updateConnection.subscribe(["workspace"], () =>
      workspace.invalidate(),
    );
    const unsubscribeSessions = updateConnection.subscribe(["sessions"], () =>
      sessions.invalidate(),
    );
    const refresh = () => {
      if (!document.hidden) void workspace.refresh(true);
    };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unsubscribeWorkspace();
      unsubscribeSessions();
      workspace.dispose();
      sessions.dispose();
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [status, userId]);
}
