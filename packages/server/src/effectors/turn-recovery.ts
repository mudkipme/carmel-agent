import type { TurnFailure } from "./failure-classifier.ts";

/**
 * Whether a failed turn is worth one more attempt, and which kind.
 *
 * Only context overflow is recovered here. It is the one provider rejection
 * Carmel can actually fix between attempts -- compaction is a real remedy, and
 * the same turn sent against a smaller context can genuinely succeed. Auth,
 * quota, and a malformed tool history all need a person, and retrying them just
 * spends the user's tokens to reach the same answer.
 *
 * Overflow survives the pre-flight compaction we already run for two reasons,
 * and they want different handling:
 *
 *  - The estimate was wrong. `estimateContextTokens` is a character heuristic
 *    reconciled against the last reported usage, so it can sit under the
 *    threshold while the provider's own count is over it. Nothing durable
 *    happened, and the cleanest repair is to pretend the attempt never did.
 *  - A tool result ballooned the context mid-turn. A file read or a long bash
 *    capture can add more in one step than the whole turn was budgeted. Here the
 *    turn *did* work, and rewinding past it would throw away exactly the
 *    expensive part.
 */

export type RecoveryAction =
  /** Not recoverable, or the budget is spent. */
  | { readonly action: "none" }
  /**
   * Rewind past the failed attempt and send the user's message again. The
   * transcript ends up as though the overflow never happened.
   */
  | { readonly action: "resend" }
  /**
   * Keep what the turn produced and ask the agent to carry on. Costs a visible
   * extra turn in the transcript, which is the price of not discarding work.
   */
  | { readonly action: "continue" };

export type RecoveryInput = {
  readonly failure: TurnFailure | undefined;
  /** Did the failed turn persist any tool results? */
  readonly turnProducedToolResults: boolean;
};

/**
 * There is no attempt budget here because there is no retry loop: the run
 * attempts this once, and a second overflow after a successful compaction is
 * information the user needs rather than something to spend more tokens on.
 * A budget belongs here the day a loop does.
 */
export function planContextRecovery(input: RecoveryInput): RecoveryAction {
  if (input.failure?.category !== "context_overflow") return { action: "none" };
  return { action: input.turnProducedToolResults ? "continue" : "resend" };
}

/**
 * Sent for the `continue` path. Deliberately says "without repeating completed
 * work": the compaction that just ran summarized the very history that proves
 * the work was done, so the agent has to be told not to redo it.
 */
export const CONTINUATION_PROMPT =
  "Continue the current task from the state recorded above. Do not repeat work that is already complete.";

export const RECOVERED_BY_RESEND =
  "This session filled its context window mid-turn. It was compacted and the message was sent again.";

export const RECOVERED_BY_CONTINUATION =
  "This session filled its context window mid-turn. It was compacted and the agent was asked to continue from where it stopped.";
