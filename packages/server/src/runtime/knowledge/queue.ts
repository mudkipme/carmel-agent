const queues = new Map<string, Promise<unknown>>();

/** Serialize mutations and worker calls; a rejected operation never poisons the queue. */
export async function knowledgeLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  try {
    return await current;
  } finally {
    if (queues.get(key) === current) queues.delete(key);
  }
}
