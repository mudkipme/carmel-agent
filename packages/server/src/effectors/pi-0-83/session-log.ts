import type { Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AgentThinkingLevel } from "@carmel-agent/shared";
import type { BranchEntry, SessionLog, SessionState } from "../contracts/session-log.ts";
import type { SessionMessage } from "../contracts/messages.ts";

/**
 * `SessionLog` over Pi 0.83's `Session`.
 *
 * Every method here is one that 0.84 renames or hides. Keeping them in a single
 * ~70-line adapter is the whole trade: the port above stays still, and the
 * rename lands in one file with a contract suite already pointed at it.
 */

type ClosableStorage = { cleanup?: () => Promise<void> };

export function createPi083SessionLog(session: Session): SessionLog {
  let closed = false;

  return {
    async readBranch() {
      return (await session.getBranch()).map(toBranchEntry);
    },

    async moveTo(entryId) {
      await session.moveTo(entryId);
    },

    async appendMessage(message: SessionMessage) {
      return session.appendMessage(message);
    },

    async readState(): Promise<SessionState> {
      // 0.84 turns this into a standalone `buildSessionContext(entries)`, which
      // is why the port asks for the three fields rather than for a context.
      const context = await session.buildContext();
      return {
        model: context.model ? { provider: context.model.provider, modelId: context.model.modelId } : null,
        thinkingLevel: (context.thinkingLevel as AgentThinkingLevel | undefined) ?? "off",
        activeToolNames: context.activeToolNames ?? null,
      };
    },

    async appendModelChange(provider, modelId) {
      await session.appendModelChange(provider, modelId);
    },

    async appendThinkingLevelChange(level) {
      await session.appendThinkingLevelChange(level);
    },

    async appendActiveToolsChange(names) {
      await session.appendActiveToolsChange([...names]);
    },

    async close() {
      // `finalizeRun` reaches here on paths where an earlier step already failed,
      // and a second cleanup on Pi's SQLite storage is not a no-op, so the guard
      // is the adapter's rather than the caller's.
      if (closed) return;
      closed = true;
      await (session.getStorage() as ClosableStorage).cleanup?.();
    },
  };
}

function toBranchEntry(entry: SessionTreeEntry): BranchEntry {
  if (entry.type === "message") {
    return { id: entry.id, parentId: entry.parentId, type: "message", message: entry.message };
  }
  return { id: entry.id, parentId: entry.parentId, type: "other" };
}
