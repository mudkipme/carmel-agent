import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StateTopic } from "@carmel-agent/shared";
import { errorMessage } from "@/lib/errors";
import { getResourceSnapshot, retainResource, type ResourceSnapshot } from "@/lib/resource-cache";

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
  const [state, setState] = useState<{ key: string; snapshot: ResourceSnapshot<T> }>(() => ({
    key,
    snapshot: getResourceSnapshot<T>(key),
  }));
  const options = useRef({ load, i18n });
  options.current = { load, i18n };
  const handle = useRef<ReturnType<typeof retainResource<T>> | undefined>(undefined);
  const refresh = useCallback(() => handle.current?.refresh() ?? Promise.resolve(undefined), []);

  useEffect(() => {
    if (!enabled) return;
    setState({ key, snapshot: getResourceSnapshot<T>(key) });
    const retained = retainResource<T>({
      key,
      load: (signal) => options.current.load(signal),
      formatError: (error) => errorMessage(error, options.current.i18n._("Unable to load data")),
      topicKey,
      onChange: () => setState({ key, snapshot: getResourceSnapshot<T>(key) }),
    });
    handle.current = retained;
    return () => {
      retained.release();
      if (handle.current === retained) handle.current = undefined;
    };
  }, [enabled, key, refreshKey, topicKey]);

  const current = state.key === key ? state.snapshot : getResourceSnapshot<T>(key);
  return {
    data: current.data,
    error: current.error,
    loading: enabled && current.data === undefined && !current.error,
    refresh,
  };
}
