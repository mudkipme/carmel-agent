import type { RunGuardLimits } from "../effectors/run-guard.ts";
import { DEFAULT_RUN_GUARD_LIMITS } from "../effectors/run-guard.ts";

/**
 * Operator-tunable runtime limits.
 *
 * Read per run rather than captured at import so an operator can change them
 * without a restart being the only way to find out whether the value was sane.
 */

export const RUN_GUARD_POLL_MS = 30_000;

/** Generous: one provider request, including long thinking and a long reply. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

export function runGuardLimits(): RunGuardLimits {
  return {
    maxToolCalls: positiveInt(
      process.env.CARMEL_AGENT_MAX_TOOL_CALLS,
      DEFAULT_RUN_GUARD_LIMITS.maxToolCalls,
    ),
    stallTimeoutMs: positiveInt(
      process.env.CARMEL_AGENT_STALL_TIMEOUT_MS,
      DEFAULT_RUN_GUARD_LIMITS.stallTimeoutMs,
    ),
  };
}

export function providerRequestTimeoutMs() {
  return positiveInt(process.env.CARMEL_AGENT_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
