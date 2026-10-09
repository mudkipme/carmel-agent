import { DEFAULT_COMPACTION_SETTINGS } from "./pi-durable/index.ts";

/**
 * Pi Durable owns compaction. Carmel scales its defaults for small model
 * windows and describes the native recovery and failure events to the user.
 * Keep compaction enabled: Durable also uses that flag for overflow recovery.
 */

/** Durable's enabled flag covers overflow recovery too; scale its policy for small model windows. */
export function compactionSettingsForWindow(contextWindow: number) {
  return {
    ...DEFAULT_COMPACTION_SETTINGS,
    reserveTokens: Math.min(
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      Math.max(1, Math.floor(contextWindow / 4)),
    ),
    keepRecentTokens: Math.min(
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
      Math.max(0, Math.floor(contextWindow / 3)),
    ),
    backgroundTokens: Math.min(
      DEFAULT_COMPACTION_SETTINGS.backgroundTokens,
      Math.max(0, Math.floor(contextWindow / 10)),
    ),
  };
}

export type ContextPressureLevel = "warning" | "critical";

export type ContextPressureNotice = {
  readonly level: ContextPressureLevel;
  readonly message: string;
};

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
