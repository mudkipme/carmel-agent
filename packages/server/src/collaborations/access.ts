import { and, eq, inArray, or } from "drizzle-orm";
import type { CollaborationGrant } from "@carmel-agent/shared";
import { db } from "../db/index.ts";
import {
  agents,
  collaborationConnections as connections,
  collaborations,
  issues,
  sessions,
} from "../db/schema.ts";
import { readVisibleAgent } from "../services/agent-access.ts";
import { abortAgentRun, getActiveAgentRunForSessionId } from "../runtime/run-stream.ts";

export type Collaboration = typeof collaborations.$inferSelect;
export type CollaborationOwner = { userId: string; agentId: string; sessionId: string };
export class CollaborationError extends Error {}

export const collaborationDenied = () =>
  new CollaborationError("Collaboration is unavailable or not permitted.");

export function authorizeCollaboration(
  userId: string,
  source: string,
  target: string,
  capability: keyof CollaborationGrant,
) {
  if (source === target || !readVisibleAgent(userId, source) || !readVisibleAgent(userId, target))
    throw collaborationDenied();
  const outgoing = db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.agentId, source),
        eq(connections.peerAgentId, target),
        eq(connections.direction, "outgoing"),
      ),
    )
    .get();
  if (!outgoing?.capabilities[capability]) throw collaborationDenied();
}

export function requireCollaborationSource(owner: CollaborationOwner) {
  const session = db.select().from(sessions).where(eq(sessions.id, owner.sessionId)).get();
  if (
    !session ||
    session.userId !== owner.userId ||
    session.agentId !== owner.agentId ||
    receiverCollaboration(session.id, session.issueId)
  )
    throw collaborationDenied();
  return session;
}

export function listCollaborators(owner: CollaborationOwner) {
  requireCollaborationSource(owner);
  return readCollaborators(owner.userId, owner.agentId);
}

export function readCollaborators(userId: string, agentId: string) {
  if (!readVisibleAgent(userId, agentId)) throw collaborationDenied();
  return db
    .select({
      agentId: agents.id,
      name: agents.name,
      description: agents.description,
      capabilities: connections.capabilities,
    })
    .from(connections)
    .innerJoin(agents, eq(agents.id, connections.peerAgentId))
    .where(
      and(
        eq(connections.agentId, agentId),
        eq(connections.direction, "outgoing"),
        or(eq(agents.ownerUserId, userId), eq(agents.shared, true)),
      ),
    )
    .all()
    .flatMap((row) => {
      if (row.agentId === agentId) return [];
      const capabilities = {
        consult: Boolean(row.capabilities.consult),
        createTask: Boolean(row.capabilities.createTask),
        queueTask: Boolean(row.capabilities.queueTask),
      };
      return Object.values(capabilities).some(Boolean) ? [{ ...row, capabilities }] : [];
    });
}

export function receiverCollaboration(sessionId: string, issueId?: string | null) {
  const session = sessionId
    ? db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
    : undefined;
  const issue = issueId ? db.select().from(issues).where(eq(issues.id, issueId)).get() : undefined;
  const scopeId = session?.collaborationId ?? issue?.collaborationId;
  if (scopeId) return db.select().from(collaborations).where(eq(collaborations.id, scopeId)).get();
  return db
    .select()
    .from(collaborations)
    .where(
      or(
        eq(collaborations.targetSessionId, sessionId),
        ...(issueId ? [eq(collaborations.targetIssueId, issueId)] : []),
      ),
    )
    .get();
}

export function assertReceiverAccess(sessionId: string, issueId?: string | null) {
  const row = receiverCollaboration(sessionId, issueId);
  const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  const issue = issueId ? db.select().from(issues).where(eq(issues.id, issueId)).get() : undefined;
  if (!row) {
    if (session?.collaborationId || issue?.collaborationId) throw collaborationDenied();
    return;
  }
  if (row.status === "cancelled") throw collaborationDenied();
  if (row.kind === "task")
    authorizeCollaboration(row.userId, row.sourceAgentId, row.targetAgentId, "createTask");
  authorizeCollaboration(
    row.userId,
    row.sourceAgentId,
    row.targetAgentId,
    row.kind === "consult" ? "consult" : "queueTask",
  );
}

export function cancelSourceCollaborations(
  sessionId: string,
  cancelTargetIssue?: (userId: string, agentId: string, issueId: string) => void,
) {
  for (const row of db
    .select()
    .from(collaborations)
    .where(
      and(
        eq(collaborations.sourceSessionId, sessionId),
        inArray(collaborations.status, ["queued", "working"]),
      ),
    )
    .all()) {
    db.update(collaborations)
      .set({ waiting: false, status: "cancelled" })
      .where(eq(collaborations.id, row.id))
      .run();
    if (row.targetIssueId) cancelTargetIssue?.(row.userId, row.targetAgentId, row.targetIssueId);
    if (row.targetSessionId) {
      const run = getActiveAgentRunForSessionId(row.targetSessionId);
      if (run) abortAgentRun(row.userId, run.runId);
    }
  }
}
