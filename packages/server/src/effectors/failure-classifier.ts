/**
 * What kind of failure ended a turn, and what the user can do about it.
 *
 * Carmel turned every failure into the provider's raw text in a red box. An
 * expired credential, an exhausted quota, a context overflow, and a tool-history
 * mismatch all looked identical, and none of them said what to do -- which
 * matters more here than in a single-user tool, because the person who can fix
 * an auth or quota problem (the admin who holds the keys) is usually not the
 * person watching the session fail.
 *
 * Pure: the provider-shaped input is a string plus the hints the caller derives.
 * Pi's own `isRetryableAssistantError` and `isContextOverflow` are hints rather
 * than dependencies, so their pattern lists stay the single source of truth for
 * what counts as transient and what counts as an overflow, without this file
 * importing either.
 */

export type FailureCategory =
  | "aborted"
  | "auth"
  | "quota"
  | "context_overflow"
  | "tool_history"
  | "model_unavailable"
  | "transient"
  | "unknown";

export type TurnFailure = {
  readonly category: FailureCategory;
  /** Whether sending the same turn again could plausibly succeed. */
  readonly retryable: boolean;
  readonly summary: string;
  /** What to do about it. Absent when there is nothing honest to suggest. */
  readonly remedy?: string;
  /** The provider's own words, preserved for whoever has to debug it. */
  readonly detail: string;
};

export type TurnFailureInput = {
  /** The provider or harness error text. */
  readonly message: string;
  readonly aborted?: boolean;
  /** Pi's transient-error verdict, when the caller has an assistant message. */
  readonly transientHint?: boolean;
  /**
   * Pi's context-overflow verdict, when the caller has an assistant message.
   *
   * Authoritative rather than a tie-breaker, because it knows two things a
   * message string cannot: which overflow-looking texts are actually throttling,
   * and whether a *successful* response silently overran the window because its
   * input usage exceeded it. A regex here would be a worse second copy of a list
   * Pi already maintains.
   */
  readonly overflowHint?: boolean;
};

/**
 * Ordered most specific first. A quota message often also matches the transient
 * patterns (both mention 429), so the order here is load-bearing, not cosmetic.
 *
 * `context_overflow` is deliberately absent: `overflowHint` decides it, from
 * Pi's own detector.
 */
const PATTERNS: readonly { category: FailureCategory; pattern: RegExp }[] = [
  {
    category: "tool_history",
    // Anthropic names the ids; OpenAI names the roles. Both mean the branch is
    // not a valid conversation, which is what `branch-integrity.ts` prevents
    // Carmel from causing on purpose.
    pattern:
      /tool_use\b[^\n]{0,80}tool_result|tool_result\b[^\n]{0,80}tool_use|unexpected[^\n]{0,20}tool_use_id|invalid[^\n]{0,20}tool.?(?:use|call|result)|messages with role ['"]?tool['"]?|tool_call_id (?:did not|does not|not found)/i,
  },
  {
    category: "quota",
    pattern:
      /insufficient_quota|exceeded your current quota|billing|payment required|\b402\b|out of budget|usage limit reached|credit balance/i,
  },
  {
    category: "auth",
    pattern:
      /\b401\b|\b403\b|unauthori[sz]ed|authentication|invalid[^\n]{0,12}api[_ -]?key|permission denied|expired[^.]{0,15}token|invalid[^.]{0,15}credential|OAuth/i,
  },
  {
    category: "model_unavailable",
    pattern:
      /model[^\n]{0,40}(?:not found|does not exist|is not supported|unavailable|not available)|unknown model|no such model/i,
  },
  {
    category: "transient",
    pattern:
      /overloaded|rate.?limit|too many requests|\b429\b|\b5[0-9]{2}\b|service.?unavailable|server.?error|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|network/i,
  },
];

const REMEDIES: Partial<Record<FailureCategory, string>> = {
  auth: "Ask an administrator to re-check this provider's credentials in Settings → Providers.",
  quota:
    "The provider account is out of quota or credit. Use a different model, or top the account up.",
  context_overflow:
    "The session is too large for this model's context window. Compaction runs automatically, so if this repeats, move to a model with a larger window or start a new session.",
  tool_history:
    "The session's tool history is not in a state the provider accepts. Fork or truncate at the last complete exchange to continue.",
  model_unavailable:
    "Check this model's entry in Settings → Models against what the provider actually serves.",
  transient: "A temporary provider problem. Send the message again.",
};

const SUMMARIES: Record<FailureCategory, string> = {
  aborted: "The run was stopped.",
  auth: "The model provider rejected the request as unauthorized.",
  quota: "The model provider refused the request for quota or billing reasons.",
  context_overflow: "The model provider rejected the request as too large for its context window.",
  tool_history: "The model provider rejected this session's tool-call history as malformed.",
  model_unavailable: "The model provider does not serve this model.",
  transient: "The model provider failed to answer.",
  unknown: "The run failed.",
};

/** Categories worth trying again unchanged. */
const RETRYABLE: ReadonlySet<FailureCategory> = new Set<FailureCategory>(["transient"]);

export function classifyTurnFailure(input: TurnFailureInput): TurnFailure {
  const detail = input.message.trim();
  if (input.aborted) {
    return { category: "aborted", retryable: false, summary: SUMMARIES.aborted, detail };
  }

  // Overflow is decided before the patterns, not after. Pi's detector already
  // rules out the throttling texts that read like an overflow, so a hit here is
  // more specific than anything the list below could match -- including the
  // gateways that wrap an overflow in "invalid_request".
  if (input.overflowHint) {
    return {
      category: "context_overflow",
      retryable: RETRYABLE.has("context_overflow"),
      summary: SUMMARIES.context_overflow,
      remedy: REMEDIES.context_overflow,
      detail,
    };
  }

  const matched = PATTERNS.find(({ pattern }) => pattern.test(detail))?.category;
  // The transient hint only promotes an otherwise-unrecognised failure. It must
  // not override a specific match: Pi reads a 429 as transient, but a quota
  // refusal that mentions 429 is not something retrying fixes.
  const category = matched ?? (input.transientHint ? "transient" : "unknown");

  return {
    category,
    retryable: RETRYABLE.has(category),
    summary: SUMMARIES[category],
    remedy: REMEDIES[category],
    detail,
  };
}

const MAX_DETAIL_CHARS = 400;

/**
 * One line for the red box. An unclassified failure keeps the provider's text
 * verbatim rather than being replaced by "The run failed" -- when the
 * classification is worst is exactly when the raw text is worth most.
 */
export function formatTurnFailure(failure: TurnFailure): string {
  if (failure.category === "unknown") return failure.detail || SUMMARIES.unknown;

  const parts = [failure.summary];
  if (failure.remedy) parts.push(failure.remedy);
  if (failure.detail && !failure.summary.includes(failure.detail)) {
    parts.push(`(${truncate(failure.detail, MAX_DETAIL_CHARS)})`);
  }
  return parts.join(" ");
}

function truncate(text: string, max: number) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
