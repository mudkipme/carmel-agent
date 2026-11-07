const queues = new Map<string, Promise<unknown>>();

/** Serialize mutations and worker calls; a rejected operation never poisons the queue. */
export async function knowledgeLock<T>(
  key: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => {
      signal?.throwIfAborted();
      return operation();
    });
  queues.set(key, current);
  const result = current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
  if (!signal) return result;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    result.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
