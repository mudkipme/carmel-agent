import type { AgentLane, Context, Entry, Session } from "@earendil-works/pi-agent-core";
import { closePiSession, PI_MAIN_BRANCH } from "../../services/pi-session-storage.ts";
import type { AgentThinkingLevel } from "@carmel-agent/shared";
import type { BranchEntry, SessionLog, SessionState } from "../contracts/session-log.ts";
import type { SessionMessage } from "../contracts/messages.ts";
import type { PiConfigLane } from "./agent-driver.ts";

/**
 * `SessionLog` over Pi 0.85's `Session`.
 *
 * The port held: every method below is one 0.85 renamed, moved or deleted, and
 * the ~90 lines here are the whole cost of that above this file.
 *
 * Two of those are more than renames. Branch traversal moved onto a named
 * `Branch` object, and per-lane configuration -- model, thinking level, active
 * tools -- stopped being entries in the session tree and became lane state, so
 * `readState` and the three `append*Change` methods now read and write a lane
 * rather than appending to a branch. They keep their names because the port
 * describes what Carmel wants, not how Pi stores it.
 */

export { PI_MAIN_BRANCH };

/**
 * Everything the log needs from the open lane.
 *
 * All of it, rather than reaching for the session's `Branch` of the same name:
 * a lane holds its tip in memory, so a branch-level append or tip write behind
 * its back is silently orphaned the next time the lane runs. The lane is the
 * only correct writer while one is open.
 */
export type PiLogLane = PiConfigLane & Pick<AgentLane, "navigateTree" | "findEntries" | "appendMessage">;

export type PiSessionLogOptions = {
  session: Session;
  /** The open lane. Configuration lives here in 0.85, not in the session tree. */
  lane: PiLogLane;
  context: Context;
};

export function createPiSessionLog({ session, lane, context }: PiSessionLogOptions): SessionLog {
  let closed = false;

  return {
    async readBranch() {
      // 0.85 defaults branch scans to `newestFirst`; every caller here reads the
      // transcript in order, and one of them takes `.at(-1)` as the tip.
      return (await lane.findEntries({ order: "oldestFirst" }, context)).map(toBranchEntry);
    },

    async moveTo(entryId) {
      // There is no `moveTo` any more, and writing the branch tip directly is
      // wrong while a lane is open -- the lane keeps appending from the tip it
      // holds in memory. `navigateTree` is the lane's own rewind; `summarize`
      // off keeps it from turning one into a summarization operation.
      await lane.navigateTree(entryId, { summarize: false }, context);
    },

    async appendMessage(message: SessionMessage) {
      return lane.appendMessage(message, context);
    },

    async readState(): Promise<SessionState> {
      const model = await lane.getModel(context);
      return {
        model: model ? { provider: model.provider, modelId: model.id } : null,
        thinkingLevel: (await lane.getThinkingLevel(context)) as AgentThinkingLevel,
        activeToolNames: await lane.getActiveTools(context),
      };
    },

    async appendModelChange(provider, modelId) {
      await lane.setModel({ provider, modelId }, context);
    },

    async appendThinkingLevelChange(level) {
      await lane.setThinkingLevel(level, context);
    },

    async appendActiveToolsChange(names) {
      await lane.setActiveTools([...names], context);
    },

    async close() {
      // `finalizeRun` reaches here on paths where an earlier step already failed,
      // and a second close on Pi's SQLite storage is not a no-op, so the guard
      // is the adapter's rather than the caller's.
      //
      // Released through the lease rather than `session.close()`: 0.85 makes a
      // session exclusive, so Carmel shares one open handle between holders and
      // only the last one out actually closes it.
      if (closed) return;
      closed = true;
      await closePiSession(session);
    },
  };
}

/** 0.85 renamed `SessionTreeEntry` to `Entry` and dropped its `leaf` and `label` variants. */
function toBranchEntry(entry: Entry): BranchEntry {
  if (entry.type === "message") {
    return { id: entry.id, parentId: entry.parentId, type: "message", message: entry.message };
  }
  return { id: entry.id, parentId: entry.parentId, type: "other" };
}
