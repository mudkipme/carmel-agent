import { api } from "./api.ts";
import type { SessionConnection } from "@carmel-agent/shared";

const inFlightConnections = new Map<string, Promise<SessionConnection>>();

/** Share only concurrent snapshot reads; completed snapshots are never cached. */
export function readSessionConnection(sessionId: string): Promise<SessionConnection> {
  const existing = inFlightConnections.get(sessionId);
  if (existing) return existing;

  const pending = api.getSessionConnection(sessionId);
  inFlightConnections.set(sessionId, pending);
  pending.then(
    () => clearPendingConnection(sessionId, pending),
    () => clearPendingConnection(sessionId, pending),
  );
  return pending;
}

function clearPendingConnection(sessionId: string, pending: Promise<SessionConnection>) {
  if (inFlightConnections.get(sessionId) === pending) inFlightConnections.delete(sessionId);
}
