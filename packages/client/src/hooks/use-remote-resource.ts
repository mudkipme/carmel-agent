import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createResourceLoader } from "@/lib/resource-loader";
import { errorMessage } from "@/lib/errors";
import type { StateTopic } from "@carmel-agent/shared";
import { updateConnection } from "@/lib/update-connection";

type ResourceState<T> = { key: string; data?: T; error?: string };

export function useRemoteResource<T>({
  key,
  load,
  enabled = true,
  refreshKey,
  topics,
}: {
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
  enabled?: boolean;
  refreshKey?: unknown;
  topics?: readonly StateTopic[];
}) {
  const { i18n } = useLingui();
  const topicKey = topics?.join(",") ?? "";
  const [state, setState] = useState<ResourceState<T>>({ key });
  const options = useRef({ load });
  options.current = { load };
  const loader = useRef<ReturnType<typeof createResourceLoader<T>> | undefined>(undefined);
  const refresh = useCallback(
    () => loader.current?.refresh(true) ?? Promise.resolve(undefined),
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    const request = createResourceLoader<T>(
      (signal) => options.current.load(signal),
      (result) => {
        if ("error" in result) {
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : undefined,
            error: errorMessage(result.error, i18n._("Unable to load data")),
          }));
        } else {
          setState({ key, data: result.data });
        }
      },
    );
    loader.current = request;
    const reconnect = () => {
      if (!document.hidden) void request.refresh(true);
    };
    const unsubscribe = topicKey
      ? updateConnection.subscribe(topicKey.split(",") as StateTopic[], () => request.invalidate())
      : undefined;
    void request.refresh();
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      unsubscribe?.();
      request.dispose();
      if (loader.current === request) loader.current = undefined;
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
    };
  }, [enabled, key, refreshKey, i18n, topicKey]);

  const current = state.key === key ? state : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: enabled && current?.data === undefined && !current?.error,
    refresh,
  };
}
