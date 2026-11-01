/** One cancellable request at a time. Only the current request may publish. */
export function createResourceLoader<T>(
  load: (signal: AbortSignal) => Promise<T>,
  publish: (result: { data: T; error?: never } | { error: unknown; data?: never }) => void,
) {
  let controller: AbortController | undefined;
  let pending: Promise<T | undefined> | undefined;
  let disposed = false;
  let refreshQueued = false;

  const refresh = (replace = false): Promise<T | undefined> => {
    if (disposed) return Promise.resolve(undefined);
    if (pending && !replace) return pending;
    refreshQueued = false;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const promise = Promise.resolve()
      .then(() => load(request.signal))
      .then(
        (data) => {
          if (disposed || request.signal.aborted) return undefined;
          publish({ data });
          return data;
        },
        (error: unknown) => {
          if (!disposed && !request.signal.aborted) publish({ error });
          return undefined;
        },
      )
      .finally(() => {
        if (pending === promise) {
          pending = undefined;
          if (refreshQueued) invalidate();
        }
      });
    pending = promise;
    return promise;
  };

  const invalidate = () => {
    if (disposed) return;
    if (pending) refreshQueued = true;
    else void refresh();
  };

  return {
    refresh,
    invalidate,
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
