import type { ActiveAgentRunSummary } from "@carmel-agent/shared";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { modelRefs, sessions } from "../db/schema.ts";
import { getActiveAgentRunForSessionId } from "../runtime/run-stream.ts";

export function readActiveRunLeaseForSession(sessionId: string) {
  return getActiveAgentRunForSessionId(sessionId);
}

export function readActiveRunLeaseForAgent(agentId: string) {
  return readFirstActiveRun(
    db.select({ id: sessions.id }).from(sessions).where(eq(sessions.agentId, agentId)).all(),
  );
}

export function readActiveRunLeaseForModels(modelIds: Iterable<string>) {
  const ids = [...modelIds];
  if (ids.length === 0) return undefined;
  return readFirstActiveRun(
    db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.modelRefId, ids)).all(),
  );
}

export function readActiveRunLeaseForProviderConfig(providerConfigId: string) {
  const ids = db
    .select({ id: modelRefs.id })
    .from(modelRefs)
    .where(eq(modelRefs.providerConfigId, providerConfigId))
    .all()
    .map((model) => model.id);
  return readActiveRunLeaseForModels(ids);
}

export function readActiveRunLeaseForUser(userId: string) {
  return readFirstActiveRun(
    db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)).all(),
  );
}

export function activeRunLeaseConflict(run: ActiveAgentRunSummary) {
  return {
    error: "The affected session has an active agent run. Stop it before making this change.",
    activeRun: run,
  };
}

function readFirstActiveRun(sessionRows: Array<{ id: string }>) {
  for (const session of sessionRows) {
    const run = getActiveAgentRunForSessionId(session.id);
    if (run) return run;
  }
  return undefined;
}
