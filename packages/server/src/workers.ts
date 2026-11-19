import { errorMessage } from "./errors.ts";

/**
 * A background part of the server. Shutdown runs in three passes: every worker
 * stops taking new work, then every worker drains what is in flight, then each
 * closes its resources in reverse start order, so what started first (the
 * sandbox runtime) is released last.
 */
export type Worker = {
  name: string;
  start?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
  drain?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
};

type Phase = "stop" | "drain" | "close";

export async function startWorkers(workers: readonly Worker[]) {
  for (const worker of workers) await worker.start?.();
}

export async function stopWorkers(workers: readonly Worker[], timeoutMs = 30_000) {
  for (const phase of ["stop", "drain", "close"] as const) {
    const ordered = phase === "close" ? [...workers].reverse() : workers;
    for (const worker of ordered) await runPhase(worker, phase, timeoutMs);
  }
}

async function runPhase(worker: Worker, phase: Phase, timeoutMs: number) {
  const step = worker[phase];
  if (!step) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([Promise.resolve().then(step), timeout]);
    if (result === "timeout")
      console.warn(`${worker.name}: ${phase} did not finish within ${timeoutMs} ms.`);
  } catch (error) {
    console.warn(`${worker.name}: ${phase} failed:`, errorMessage(error));
  } finally {
    clearTimeout(timer);
  }
}
