import type { ActiveAgentRunSummary } from "@carmel-agent/shared";
import type { Context } from "hono";
import type { AuthVariables } from "../auth.ts";
import { activeRunLeaseConflict } from "../services/active-run-lease.ts";

export function activeRunConflictResponse(
  c: Context<{ Variables: AuthVariables }>,
  run: ActiveAgentRunSummary,
) {
  c.header("x-agent-run-id", run.runId);
  return c.json(activeRunLeaseConflict(run), 409);
}
