import type { PiSession } from "../../services/pi-session-storage.ts";
import {
  appendPiMessage,
  closePiSession,
  navigatePiSession,
  readPiSessionBranch,
} from "../../services/pi-session-storage.ts";
import type { SessionLog } from "../contracts/session-log.ts";

/** Public branch IDs and application-owned error messages over a native conversation. */
export function createPiSessionLog({
  session,
  onNavigate,
}: {
  session: PiSession;
  onNavigate?: () => Promise<void>;
}): SessionLog {
  let closed = false;
  return {
    readBranch: () => readPiSessionBranch(session),
    async moveTo(entryId) {
      await navigatePiSession(session, entryId);
      await onNavigate?.();
    },
    appendMessage: (message) => appendPiMessage(session, message),
    async close() {
      if (closed) return;
      closed = true;
      await closePiSession(session);
    },
  };
}
