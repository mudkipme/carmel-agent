import { useCallback, useEffect, useRef, useState } from "react";
import { createResourceLoader } from "@/lib/resource-loader";
import { errorMessage } from "@/lib/errors";

type ResourceState<T> = { key: string; data?: T; error?: string };

/** Shared lifecycle for page data; live agent messages still use Pi's stream. */
export function useRemoteResource<T>({
  key,
  load,
  enabled = true,
  pollInterval = false,
  refreshKey,
}: {
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
  enabled?: boolean;
  pollInterval?: number | false | ((data: T | undefined) => number | false);
  refreshKey?: unknown;
}) {
  const [state, setState] = useState<ResourceState<T>>({ key });
  const options = useRef({ load, pollInterval });
  options.current = { load, pollInterval };
  const loader = useRef<ReturnType<typeof createResourceLoader<T>> | undefined>(undefined);
  const refresh = useCallback(
    () => loader.current?.refresh(true) ?? Promise.resolve(undefined),
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let data: T | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = createResourceLoader<T>(
      (signal) => options.current.load(signal),
      (result) => {
        if ("error" in result) {
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : undefined,
            error: errorMessage(result.error, "Unable to load data"),
          }));
        } else {
          data = result.data;
          setState({ key, data });
        }
        schedule();
      },
    );
    loader.current = request;
    const schedule = () => {
      if (disposed) return;
      clearTimeout(timer);
      const interval = options.current.pollInterval;
      const delay = typeof interval === "function" ? interval(data) : interval;
      if (delay !== false) timer = setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (!document.hidden) await request.refresh();
      schedule();
    };
    const reconnect = () => {
      if (!document.hidden) void request.refresh(true).then(schedule);
    };
    void request.refresh().then(schedule);
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      disposed = true;
      request.dispose();
      if (loader.current === request) loader.current = undefined;
      clearTimeout(timer);
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
    };
  }, [enabled, key, refreshKey]);

  const current = state.key === key ? state : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: enabled && current?.data === undefined && !current?.error,
    refresh,
  };
}
