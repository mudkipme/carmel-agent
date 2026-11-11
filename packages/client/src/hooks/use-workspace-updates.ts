import { useEffect } from "react";
import { api, ApiError } from "@/lib/api";
import { createResourceLoader } from "@/lib/resource-loader";
import { updateConnection } from "@/lib/update-connection";
import { resolveBootstrapState, resetState } from "@/store/harness-state";
import { useHarnessStore } from "@/store/harness-store";

export function useWorkspaceUpdates() {
  const status = useHarnessStore((state) => state.status);
  const userId = useHarnessStore((state) => state.activeUserId);
  useEffect(() => {
    if (status !== "ready") return;
    const loader = createResourceLoader(
      () => api.bootstrap(),
      (result) => {
        const state = useHarnessStore.getState();
        if (state.activeUserId !== userId || state.status !== "ready") return;
        if ("error" in result) {
          if (result.error instanceof ApiError && result.error.status === 401)
            useHarnessStore.setState((state) => resetState({ status: "unauthenticated" }, state));
          return;
        }
        useHarnessStore.setState(resolveBootstrapState(result.data, state));
      },
    );
    const unsubscribe = updateConnection.subscribe(["workspace", "sessions"], () =>
      loader.invalidate(),
    );
    const refresh = () => {
      if (!document.hidden) void loader.refresh(true);
    };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unsubscribe();
      loader.dispose();
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [status, userId]);
}
