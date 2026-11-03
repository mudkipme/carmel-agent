import type { Session, SessionConnection } from "@carmel-agent/shared";
import { sessionRunSnapshot, sessionRunVersion } from "../runtime/run-stream.ts";
import { serializeSession } from "../serializers.ts";
import { loadOwnedSessionPage } from "./session-store.ts";
import { hasPendingPiSessionWork } from "./pi-session-storage.ts";
import { withPiSession } from "./pi-session-storage.ts";
import { readUserRequests } from "./user-requests.ts";
import { PENDING_ENTRY_ID_PREFIX } from "./pi-session-storage.ts";

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
  while (true) {
    const version = sessionRunVersion(sessionId);
    const session = await readSessionSnapshot(userId, sessionId);
    if (!session) return undefined;
    const pendingWork = await hasPendingPiSessionWork(sessionId);
    const userRequests = await withPiSession(sessionId, async (pi) =>
      readUserRequests(sessionId, String(pi.conversation.id)),
    );
    if (version !== sessionRunVersion(sessionId)) continue;
    const run = sessionRunSnapshot(userId, sessionId);
    if (run.activeRun) {
      const streaming = run.runProgress?.live?.generation?.message;
      const committed = session.messageEntryIds.flatMap((id, index) => {
        const message = session.messages[index]!;
        return id.startsWith(PENDING_ENTRY_ID_PREFIX) ||
          (index === session.messages.length - 1 &&
            streaming &&
            message.role === streaming.role &&
            message.timestamp === streaming.timestamp)
          ? []
          : [{ id, message }];
      });
      session.messages = committed.map((entry) => entry.message);
      session.messageEntryIds = committed.map((entry) => entry.id);
    }
    return {
      session,
      ...run,
      pendingWork,
      userRequests,
    };
  }
}
