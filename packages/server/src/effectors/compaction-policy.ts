import {
  CompactionEntry,
  CompactionTask,
  DEFAULT_COMPACTION_POLICY,
  LiveDoc,
  defineExtension,
  hook,
} from "@earendil-works/pi-durable";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

/** Durable's enabled flag covers overflow recovery too; scale its policy for small model windows. */
export function compactionSettingsForWindow(
  contextWindow: number,
  kind: "session" | "home" = "session",
  fixedTokens = 0,
) {
  const policy = {
    ...DEFAULT_COMPACTION_POLICY,
    reserveTokens: Math.min(
      DEFAULT_COMPACTION_POLICY.reserveTokens,
      Math.max(1, Math.floor(contextWindow / 4)),
    ),
    keepRecentTokens: Math.min(
      DEFAULT_COMPACTION_POLICY.keepRecentTokens,
      Math.max(0, Math.floor(contextWindow / 3)),
    ),
    backgroundTokens: Math.min(
      DEFAULT_COMPACTION_POLICY.backgroundTokens,
      Math.max(0, Math.floor(contextWindow / 10)),
    ),
  };
  if (kind !== "home") return policy;
  const available = Math.max(0, contextWindow - policy.reserveTokens - fixedTokens);
  const backgroundThreshold =
    fixedTokens + Math.min(48_000, Math.max(1, Math.floor(available / 2)));
  return {
    ...policy,
    keepRecentTokens: Math.min(12_000, Math.floor(available / 5)),
    backgroundTokens: Math.max(0, contextWindow - policy.reserveTokens - backgroundThreshold),
  };
}

export function homeCompactionExtension(contextWindow: number, fixedTokens = 0) {
  const policy = compactionSettingsForWindow(contextWindow);
  const available = Math.max(0, contextWindow - policy.reserveTokens - fixedTokens);
  return defineExtension({
    name: "carmel.home-compaction",
    hooks: [
      hook(CompactionTask, {
        async beforeCompact(compaction, api, context) {
          if (compaction.reason !== "threshold") return;
          const live = await api.snapshot(LiveDoc, api.conversationId, context);
          if (live?.compactions?.find((item) => item.taskId === api.taskId)?.blocking !== false)
            return;
          // Fixed instructions and the previous summary cannot provide new history to compact.
          const tokens = compaction.entries
            .filter((entry) => entry.kind !== CompactionEntry.kind)
            .flatMap((entry) => entry.model ?? [])
            .filter((message) => message.role !== "system")
            .reduce((total, message) => total + estimateMessageTokens(message), 0);
          if (tokens < Math.min(8_000, Math.max(1, Math.floor(available / 8))))
            return { decline: true };
        },
      }),
    ],
  });
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
    message: `Automatic compaction failed (${reason}). The conversation history is unchanged; compaction will be retried when needed.`,
  };
}
