import type { Session, SessionConnection } from "@carmel-agent/shared";
import { getActiveAgentRunForSession } from "../runtime/run-stream.ts";
import { serializeSession } from "../serializers.ts";
import { loadOwnedSession } from "./session-store.ts";

/** Build the single display-safe projection used by every full-session GET. */
export async function readSessionSnapshot(
  userId: string,
  sessionId: string,
): Promise<Session | undefined> {
  const session = await loadOwnedSession(userId, sessionId);
  return session ? serializeSession(session) : undefined;
}

/** Add volatile run authority to the same session projection for reconnects. */
export async function readSessionConnection(
  userId: string,
  sessionId: string,
): Promise<SessionConnection | undefined> {
  const session = await readSessionSnapshot(userId, sessionId);
  if (!session) return undefined;
  return {
    session,
    activeRun: getActiveAgentRunForSession(userId, sessionId) ?? null,
  };
}
