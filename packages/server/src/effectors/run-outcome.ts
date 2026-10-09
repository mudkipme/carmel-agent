import type { AgentRunResult } from "@carmel-agent/shared";

/**
 * Who asked a run to stop. The abort itself is the same in every case -- the
 * lane is aborted -- so this is the only record of why.
 */
export type RunAbortReason = "user" | "guard" | "shutdown";

/** What the run body learned from one finished turn, in Carmel's terms. */
export type TurnEnd = {
  /** The turn's stop reason as the provider layer reported it. */
  stopReason: string;
  /** The formatted failure, when the turn failed. */
  detail?: string;
};

export const INTERRUPTED_DETAIL = "The server stopped before this run finished.";

/**
 * Decides how a run ended.
 *
 * A run reports its failures into the transcript rather than throwing them, and
 * a provider rejection never throws at all -- it becomes an assistant message
 * with `stopReason: "error"`. So "the run body returned" says nothing about
 * whether it worked. This collects the signals as the run goes and turns them
 * into one result that chat and the scheduler both read.
 *
 * Precedence, most authoritative first:
 * 1. An abort: a person stopping the run is `cancelled`, a shutdown is
 *    `interrupted`, and the run guard is `failed` with its reason.
 * 2. An error thrown out of the run body.
 * 3. The last turn: `error` fails the run. Only the last one counts, because a
 *    recovered overflow leaves a failed turn followed by a clean one.
 * 4. Otherwise it succeeded.
 *
 * A result that could not be saved fails the run whatever came before, unless
 * it had already failed -- the original failure is the more useful thing to say.
 */
export class RunOutcome {
  #thrown?: string;
  #lastTurn?: TurnEnd;
  #persistenceFailure?: string;

  recordTurnEnd(turn: TurnEnd) {
    this.#lastTurn = turn;
  }

  recordThrown(detail: string) {
    this.#thrown ??= detail;
  }

  recordPersistenceFailure(detail: string) {
    this.#persistenceFailure ??= detail;
  }

  result(abortReason?: RunAbortReason): AgentRunResult {
    const ended = this.#endedAs(abortReason);
    if (!this.#persistenceFailure || ended.outcome === "failed") return ended;
    return {
      outcome: "failed",
      detail: `The run's result could not be saved: ${this.#persistenceFailure}`,
    };
  }

  #endedAs(abortReason?: RunAbortReason): AgentRunResult {
    if (abortReason === "user") return { outcome: "cancelled" };
    if (abortReason === "shutdown") return { outcome: "interrupted", detail: INTERRUPTED_DETAIL };
    if (abortReason === "guard")
      return { outcome: "failed", detail: this.#thrown ?? "The run guard stopped this run." };
    if (this.#thrown) return { outcome: "failed", detail: this.#thrown };
    if (this.#lastTurn?.stopReason === "error") {
      return {
        outcome: "failed",
        detail: this.#lastTurn.detail ?? "The provider returned an error.",
      };
    }
    if (this.#lastTurn?.stopReason === "aborted") {
      // Nothing here asked for it, so something below the run did.
      return { outcome: "failed", detail: this.#lastTurn.detail ?? "The turn was aborted." };
    }
    return { outcome: "succeeded" };
  }
}
