/** One cancellable request at a time. Only the current request may publish. */
export function createResourceLoader<T>(
  load: (signal: AbortSignal) => Promise<T>,
  publish: (result: { data: T; error?: never } | { error: unknown; data?: never }) => void,
) {
  let controller: AbortController | undefined;
  let pending: Promise<T | undefined> | undefined;
  let disposed = false;

  const refresh = (replace = false): Promise<T | undefined> => {
    if (disposed) return Promise.resolve(undefined);
    if (pending && !replace) return pending;
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
        if (pending === promise) pending = undefined;
      });
    pending = promise;
    return promise;
  };

  return {
    refresh,
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}
