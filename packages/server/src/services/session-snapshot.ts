import type { Session, SessionConnection } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { sessionRunSnapshot, sessionRunVersion } from "../runtime/run-stream.ts";
import { serializeSession } from "../serializers.ts";
import { loadOwnedSessionPage } from "./session-store.ts";
import {
  PENDING_ENTRY_ID_PREFIX,
  piSessionHasPendingWork,
  readPiSessionPage,
  withPiSession,
} from "./pi-session-storage.ts";
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

/** Retryable error raised when active run mutations prevent a consistent snapshot. */
export class SessionSnapshotError extends Error {
  constructor(
    message = "Session snapshot is temporarily unavailable; please retry.",
    public readonly status = 503 as const,
  ) {
    super(message);
    this.name = "SessionSnapshotError";
  }
}

/** Add volatile run authority to the same session projection for reconnects. */
export async function readSessionConnection(
  userId: string,
  sessionId: string,
  maxAttempts = 5,
): Promise<SessionConnection | undefined> {
  const initial = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!initial || initial.userId !== userId) return undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const version = sessionRunVersion(sessionId);
    const { page, pendingWork, userRequests } = await withPiSession(sessionId, async (pi) => {
      const page = await readPiSessionPage(pi, undefined, 100);
      const pendingWork = await piSessionHasPendingWork(pi);
      const userRequests = readUserRequests(sessionId, String(pi.conversation.id));
      return { page, pendingWork, userRequests };
    });
    const record = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!record || record.userId !== userId) return undefined;
    if (version !== sessionRunVersion(sessionId)) continue;

    const entries = page.entries.flatMap((entry) =>
      entry.type === "message" ? [{ entryId: entry.id, message: entry.message }] : [],
    );
    const session: Session = {
      ...serializeSession({
        ...record,
        messages: entries.map((entry) => entry.message),
        messageEntryIds: entries.map((entry) => entry.entryId),
        olderCursor: page.olderCursor,
      }),
      observedAt: Date.now(),
    };
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
  throw new SessionSnapshotError();
}
