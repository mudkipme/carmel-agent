import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentThinkingLevel } from "./schemas.ts";

export type SessionFork = {
  sessionId: string;
  entryId: string;
};

/** Everything about a session except its transcript. */
export type SessionMetadata = {
  id: string;
  title: string;
  userId: string;
  agentId: string;
  modelRefId: string;
  thinkingLevel: AgentThinkingLevel;
  revision: number;
  forkedFrom?: SessionFork;
  pinnedAt?: number;
  archivedAt?: number;
  /** Set on a task run's session, which stays out of the session list. */
  taskId?: string;
  /** Set on an issue's session, which the issue list shows instead of the session list. */
  issueId?: string;
  createdAt: number;
  updatedAt: number;
};

export type Session = SessionMetadata & {
  messages: AgentMessage[];
  messageEntryIds: string[];
};

export type SessionImportResult = {
  sessions: Session[];
  skipped: number;
};

/**
 * Anything the metadata projection can be built from: a `Session`, another
 * `SessionMetadata`, or a database row (which stores the optional columns as null).
 */
export type SessionMetadataSource = Omit<SessionMetadata, "forkedFrom" | "pinnedAt" | "archivedAt" | "taskId" | "issueId"> & {
  forkedFrom?: SessionFork | null;
  pinnedAt?: number | null;
  archivedAt?: number | null;
  taskId?: string | null;
  issueId?: string | null;
};

/**
 * The single session -> metadata projection. Both the client store and the server
 * serializers use it, so a new session column is added in exactly one place.
 */
export function toSessionMetadata(session: SessionMetadataSource): SessionMetadata {
  return {
    id: session.id,
    title: session.title,
    userId: session.userId,
    agentId: session.agentId,
    modelRefId: session.modelRefId,
    thinkingLevel: session.thinkingLevel,
    revision: session.revision,
    forkedFrom: session.forkedFrom ?? undefined,
    pinnedAt: session.pinnedAt ?? undefined,
    archivedAt: session.archivedAt ?? undefined,
    taskId: session.taskId ?? undefined,
    issueId: session.issueId ?? undefined,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

/** The inverse projection: the nullable column shape the sessions table stores. */
export function toSessionRow(session: SessionMetadataSource) {
  return {
    ...toSessionMetadata(session),
    forkedFrom: session.forkedFrom ?? null,
    pinnedAt: session.pinnedAt ?? null,
    archivedAt: session.archivedAt ?? null,
    taskId: session.taskId ?? null,
    issueId: session.issueId ?? null,
  };
}
