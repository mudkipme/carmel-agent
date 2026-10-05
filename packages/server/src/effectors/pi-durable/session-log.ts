import type { AgentLane, Context, Entry, Session } from "./index.ts";
import { closePiSession, PI_MAIN_BRANCH } from "../../services/pi-session-storage.ts";
import type { BranchEntry, SessionLog } from "../contracts/session-log.ts";
import type { SessionMessage } from "../contracts/messages.ts";

/** Carmel's branch contract over the selected Durable conversation. */

export { PI_MAIN_BRANCH };

/**
 * Everything the log needs from the open lane.
 *
 * Navigation also reattaches the native event stream, so mutations go through
 * the run's conversation handle.
 */
export type PiLogLane = Pick<AgentLane, "navigateTree" | "findEntries" | "appendMessage">;

export type PiSessionLogOptions = {
  session: Session;
  lane: PiLogLane;
  context: Context;
};

export function createPiSessionLog({ session, lane, context }: PiSessionLogOptions): SessionLog {
  let closed = false;

  return {
    async readBranch() {
      return (await lane.findEntries({ order: "oldestFirst" }, context)).map(toBranchEntry);
    },

    async moveTo(entryId) {
      // Durable forks at the selected entry, retaining the abandoned history.
      await lane.navigateTree(entryId, { summarize: false }, context);
    },

    async appendMessage(message: SessionMessage) {
      return lane.appendMessage(message, context);
    },

    async close() {
      // HTTP readers can share this handle. Only the final lease closes native storage.
      if (closed) return;
      closed = true;
      await closePiSession(session);
    },
  };
}

function toBranchEntry(entry: Entry): BranchEntry {
  if (entry.type === "message") {
    return { id: entry.id, parentId: entry.parentId, type: "message", message: entry.message };
  }
  return { id: entry.id, parentId: entry.parentId, type: "other" };
}
