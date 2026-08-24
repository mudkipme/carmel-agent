/**
 * Limits on what a single run may do before the server stops it.
 *
 * Pi's agent loop has no iteration cap -- it runs until the model stops asking
 * for tools -- and Carmel's bash tool only times out when the *model* supplies a
 * timeout argument. So a model that loops on a tool, or a command that hangs
 * with no timeout, runs until somebody notices. On a single-user machine that is
 * an annoyance; on a shared instance it is one user's agent holding another
 * user's container CPU, and the session's mutation lease with it.
 *
 * Pure and clock-injected: the interesting cases are all about elapsed time and
 * counts, and neither should need a real timer to test.
 */

export type RunGuardLimits = {
  /** Tool executions allowed in one run. */
  readonly maxToolCalls: number;
  /** Milliseconds without any observed activity before a run counts as stuck. */
  readonly stallTimeoutMs: number;
};

/**
 * Chosen to catch runaway loops and hangs, not to shape ordinary work. A real
 * task can legitimately make a hundred tool calls; nothing legitimate makes
 * hundreds while producing no other activity for a quarter of an hour.
 */
export const DEFAULT_RUN_GUARD_LIMITS: RunGuardLimits = {
  maxToolCalls: 250,
  stallTimeoutMs: 15 * 60_000,
};

export type RunGuardStopReason = "tool_ceiling" | "stalled";

export type RunGuardStop = {
  readonly reason: RunGuardStopReason;
  readonly message: string;
  readonly toolCalls: number;
  readonly idleMs: number;
};

export class RunGuard {
  readonly #limits: RunGuardLimits;
  readonly #now: () => number;
  #toolCalls = 0;
  #lastActivityAt: number;
  #stop: RunGuardStop | undefined;

  constructor(limits: RunGuardLimits = DEFAULT_RUN_GUARD_LIMITS, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
    this.#lastActivityAt = now();
  }

  /** Any sign of life: a token, a tool starting, a message closing. */
  recordActivity() {
    this.#lastActivityAt = this.#now();
  }

  /** Counts one completed tool execution. Returns a stop when that was one too many. */
  recordToolCall(): RunGuardStop | undefined {
    this.recordActivity();
    this.#toolCalls += 1;
    if (this.#toolCalls <= this.#limits.maxToolCalls) return undefined;
    return this.#record("tool_ceiling", `This run was stopped after ${this.#limits.maxToolCalls} tool calls.`);
  }

  /** Checked on a timer. Returns a stop when nothing has happened for too long. */
  poll(): RunGuardStop | undefined {
    if (this.#stop) return this.#stop;
    const idleMs = this.#now() - this.#lastActivityAt;
    if (idleMs < this.#limits.stallTimeoutMs) return undefined;
    return this.#record("stalled", `This run was stopped after ${Math.round(idleMs / 60_000)} minutes without progress.`);
  }

  /** The stop that ended this run, once one has been recorded. */
  get stop() {
    return this.#stop;
  }

  get toolCalls() {
    return this.#toolCalls;
  }

  // First stop wins and is final: a run being torn down still emits events, and
  // a second verdict would overwrite the reason the user is about to be given.
  #record(reason: RunGuardStopReason, message: string): RunGuardStop {
    this.#stop ??= { reason, message, toolCalls: this.#toolCalls, idleMs: this.#now() - this.#lastActivityAt };
    return this.#stop;
  }
}

/** Thrown into the run body so a guard stop is persisted like any other failure. */
export class RunGuardError extends Error {
  constructor(readonly stop: RunGuardStop) {
    super(stop.message);
    this.name = "RunGuardError";
  }
}
