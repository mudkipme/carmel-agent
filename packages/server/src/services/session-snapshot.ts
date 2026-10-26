import type { Session, SessionConnection } from "@carmel-agent/shared";
import { getActiveAgentRunForSession } from "../runtime/run-stream.ts";
import { serializeSession } from "../serializers.ts";
import { loadOwnedSessionPage } from "./session-store.ts";
import { hasPendingPiSessionWork } from "./pi-session-storage.ts";
import { withPiSession } from "./pi-session-storage.ts";
import { readUserRequests } from "./user-requests.ts";

/** Build the single display-safe projection used by every full-session GET. */
export async function readSessionSnapshot(
  userId: string,
  sessionId: string,
  cursor?: string,
  around?: string,
): Promise<Session | undefined> {
  const session = await loadOwnedSessionPage(userId, sessionId, cursor, around);
  return session ? { ...serializeSession(session), observedAt: Date.now() } : undefined;
}

/** Add volatile run authority to the same session projection for reconnects. */
export async function readSessionConnection(
  userId: string,
  sessionId: string,
): Promise<SessionConnection | undefined> {
  const session = await readSessionSnapshot(userId, sessionId);
  if (!session) return undefined;
  const pendingWork = await hasPendingPiSessionWork(sessionId);
  return {
    session,
    activeRun: getActiveAgentRunForSession(userId, sessionId) ?? null,
    pendingWork,
    userRequests: await withPiSession(sessionId, async (pi) =>
      readUserRequests(sessionId, String(pi.conversation.id)),
    ),
  };
}
