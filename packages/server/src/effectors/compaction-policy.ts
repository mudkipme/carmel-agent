/**
 * What Carmel tells the user about compaction, and the one thing it tells Pi.
 *
 * Pi 0.85 does the compacting: it checks the threshold at every checkpoint of a
 * run, and compacts and retries an overflowed generation once. What it does not
 * do is notice when compaction cannot help. Its predicate answers "is the
 * context over the threshold?", and for small windows the answer stays yes
 * after every summary -- so it pays for one per step, forever. Carmel detects
 * that configuration, switches Pi's threshold compaction off for it, and says
 * so; everything else here is wording for events Pi already emits.
 */

export type CompactionSettings = {
  /** Tokens held back for the summarization prompt and its output. */
  readonly reserveTokens: number;
  /** Recent context compaction retains, and therefore the floor it can reach. */
  readonly keepRecentTokens: number;
};

/** Pi's defaults (unchanged through 0.85), restated so the arithmetic below has no hidden inputs. */
export const PI_COMPACTION_SETTINGS: CompactionSettings = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export type ImpossibleReason = "window_below_reserve" | "retained_tail_exceeds_headroom";

/**
 * `headroom` is the usable context: everything the reserve does not claim. Pi
 * compares against exactly this, and it can be negative.
 */
export function contextHeadroom(contextWindow: number, settings: CompactionSettings = PI_COMPACTION_SETTINGS) {
  return contextWindow - settings.reserveTokens;
}

/**
 * Why threshold compaction can never bring this model's sessions back under
 * budget, or undefined when it can.
 *
 * - A window smaller than the reserve leaves nothing to work in: the threshold
 *   is negative, so even an empty session asks to be compacted.
 * - Compaction keeps roughly `keepRecentTokens` verbatim, so that is the floor
 *   it can reach. With Pi's defaults any window at or below 36,384 tokens has
 *   that floor above its threshold -- most locally-served Ollama models.
 */
export function compactionCannotHelp(
  contextWindow: number,
  settings: CompactionSettings = PI_COMPACTION_SETTINGS,
): ImpossibleReason | undefined {
  const headroom = contextHeadroom(contextWindow, settings);
  if (headroom <= 0) return "window_below_reserve";
  if (settings.keepRecentTokens >= headroom) return "retained_tail_exceeds_headroom";
  return undefined;
}

export type ContextPressureLevel = "warning" | "critical";

export type ContextPressureNotice = {
  readonly level: ContextPressureLevel;
  readonly message: string;
};

/**
 * Before a run: tell the user when the session is over budget on a model whose
 * window compaction cannot work in. Under budget, there is nothing to act on
 * yet; a window below the reserve is reported regardless, since it never works.
 */
export function describePreflightPressure(input: {
  tokens: number;
  contextWindow: number;
  settings?: CompactionSettings;
}): ContextPressureNotice | undefined {
  const settings = input.settings ?? PI_COMPACTION_SETTINGS;
  const reason = compactionCannotHelp(input.contextWindow, settings);
  if (reason === "window_below_reserve") {
    return {
      level: "critical",
      message: `This model's context window (${format(input.contextWindow)} tokens) is too small to compact. Switch to a model with a larger window, or start a new session.`,
    };
  }
  const headroom = contextHeadroom(input.contextWindow, settings);
  if (reason === "retained_tail_exceeds_headroom" && input.tokens > headroom) {
    return {
      level: "critical",
      message: `This session is over its context budget and compaction cannot recover it: the recent history it must keep (~${format(settings.keepRecentTokens)} tokens) already exceeds this model's usable window (${format(headroom)}). Switch to a model with a larger window, or start a new session.`,
    };
  }
  return undefined;
}

/** Pi compacted after an overflow and is retrying the generation. */
export const OVERFLOW_RECOVERED =
  "This session filled its context window mid-turn. It was compacted and the request was retried.";

/** A run ended on an overflow Pi could not recover. */
export function describeUnrecoveredOverflow(piCompacted: boolean): ContextPressureNotice {
  return {
    level: "critical",
    message: piCompacted
      ? "This session filled its context window mid-turn and compaction did not recover it. Move to a model with a larger window, or start a new session."
      : "This turn is too large for this model's context window, and there is no older history to summarize. Move to a model with a larger window, or start a new session.",
  };
}

/** One of Pi's own compactions failed. The session may still fit; the next run tries again. */
export function describeCompactionFailure(reason: string): ContextPressureNotice {
  return {
    level: "warning",
    message: `Automatic compaction failed (${reason}). This session is near its context limit and will be retried on the next turn.`,
  };
}

function format(tokens: number) {
  return Math.max(0, Math.round(tokens)).toLocaleString("en-US");
}
