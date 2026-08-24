/**
 * When compaction is worth attempting, decided without calling anything.
 *
 * The version this replaces asked Pi's `shouldCompact()` and did what it said.
 * That predicate answers one question -- "is the context over the threshold?" --
 * and Carmel was reading it as the answer to a different one: "will compacting
 * help?". For most models those coincide. For the ones Carmel lets people
 * configure by hand, they do not, and the gap is paid for in summarization calls
 * that cannot succeed.
 */

export type CompactionSettings = {
  /** Tokens held back for the summarization prompt and its output. */
  readonly reserveTokens: number;
  /** Recent context compaction retains, and therefore the floor it can reach. */
  readonly keepRecentTokens: number;
};

/** Pi 0.83's defaults, restated so the arithmetic below has no hidden inputs. */
export const PI_083_COMPACTION_SETTINGS: CompactionSettings = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export type CompactionDecision =
  /** Under the threshold. */
  | { readonly action: "none"; readonly tokens: number; readonly headroom: number }
  /** Over the threshold, and compaction can plausibly get back under it. */
  | { readonly action: "compact"; readonly tokens: number; readonly headroom: number }
  /**
   * Over the threshold, and no summary can fix it. Attempting anyway costs a
   * model call per turn and changes nothing, so this is reported rather than
   * tried.
   */
  | {
      readonly action: "impossible";
      readonly tokens: number;
      readonly headroom: number;
      readonly reason: ImpossibleReason;
    };

export type ImpossibleReason = "window_below_reserve" | "retained_tail_exceeds_headroom";

/**
 * `headroom` is the usable context: everything the reserve does not claim. Pi
 * compares against exactly this, and it can be negative -- which is the first
 * of the two impossible cases.
 */
export function contextHeadroom(contextWindow: number, settings: CompactionSettings) {
  return contextWindow - settings.reserveTokens;
}

export function decideCompaction(input: {
  tokens: number;
  contextWindow: number;
  settings?: CompactionSettings;
}): CompactionDecision {
  const settings = input.settings ?? PI_083_COMPACTION_SETTINGS;
  const { tokens } = input;
  const headroom = contextHeadroom(input.contextWindow, settings);

  // A window smaller than the reserve leaves nothing to work in. Pi's predicate
  // reads `tokens > negative`, which is true for an empty session, so this
  // configuration asks for compaction on the very first turn and every turn
  // after it.
  if (headroom <= 0) return { action: "impossible", tokens, headroom, reason: "window_below_reserve" };

  if (tokens <= headroom) return { action: "none", tokens, headroom };

  // Compaction replaces old history with a summary but retains roughly
  // `keepRecentTokens` of recent turns verbatim, so that is the floor it can
  // reach. When the floor is already above the threshold, a successful
  // compaction still leaves the session over budget -- and the next turn asks
  // again. Reachable today: with Pi's defaults any window at or below 36,384
  // tokens is in this state, which covers most locally-served models someone
  // might add as an Ollama entry.
  if (settings.keepRecentTokens >= headroom) {
    return { action: "impossible", tokens, headroom, reason: "retained_tail_exceeds_headroom" };
  }

  return { action: "compact", tokens, headroom };
}

/** What happened, in the terms the caller has to make a decision about. */
export type CompactionOutcome =
  | { readonly status: "not_needed"; readonly tokens: number; readonly headroom: number }
  | {
      readonly status: "compacted";
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly headroom: number;
    }
  /**
   * Compaction ran, and the session is still over the threshold. Distinct from
   * `failed`: nothing errored, the summary just did not buy enough room.
   */
  | {
      readonly status: "ineffective";
      readonly tokensBefore: number;
      readonly tokensAfter: number;
      readonly headroom: number;
    }
  | {
      readonly status: "impossible";
      readonly tokens: number;
      readonly headroom: number;
      readonly reason: ImpossibleReason;
    }
  /** Over the threshold, but there was no history old enough to summarize. */
  | { readonly status: "nothing_to_compact"; readonly tokens: number; readonly headroom: number }
  | {
      readonly status: "failed";
      readonly tokens: number;
      readonly headroom: number;
      readonly code: string;
      readonly reason: string;
    };

export type ContextPressureLevel = "warning" | "critical";

export type ContextPressureNotice = {
  readonly level: ContextPressureLevel;
  readonly message: string;
};

/**
 * Turn an outcome into something worth telling the user, or nothing.
 *
 * Only the states the user can act on produce a notice. `critical` means the
 * session will not accept another turn of this size without losing something;
 * `warning` means it worked but the next turn may not.
 */
export function describeContextPressure(outcome: CompactionOutcome): ContextPressureNotice | undefined {
  switch (outcome.status) {
    case "not_needed":
    case "compacted":
      return undefined;

    case "impossible":
      return {
        level: "critical",
        message:
          outcome.reason === "window_below_reserve"
            ? `This model's context window (${format(outcome.headroom + PI_083_COMPACTION_SETTINGS.reserveTokens)} tokens) is too small to compact. Switch to a model with a larger window, or start a new session.`
            : `This session is over its context budget and compaction cannot recover it: the recent history it must keep (~${format(PI_083_COMPACTION_SETTINGS.keepRecentTokens)} tokens) already exceeds this model's usable window (${format(outcome.headroom)}). Switch to a model with a larger window, or start a new session.`,
      };

    case "ineffective":
      return {
        level: "critical",
        message: `Compaction ran but the session is still over its context budget (~${format(outcome.tokensAfter)} of ${format(outcome.headroom)} usable tokens). The next turn may be rejected; consider a model with a larger window, or a new session.`,
      };

    case "nothing_to_compact":
      return {
        level: "critical",
        message: `This session is over its context budget (~${format(outcome.tokens)} of ${format(outcome.headroom)} usable tokens) but has no history old enough to summarize. A single turn is too large for this model.`,
      };

    case "failed":
      return {
        level: "warning",
        message: `Automatic compaction failed (${outcome.reason}). This session is near its context limit and will be retried on the next turn.`,
      };
  }
}

function format(tokens: number) {
  return Math.max(0, Math.round(tokens)).toLocaleString("en-US");
}
