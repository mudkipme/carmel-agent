import type { SessionMessage } from "./messages.ts";

/**
 * The session tree, as Carmel uses it.
 *
 * Separate from `AgentDriver` because upstream reshapes the loop and the store
 * on independent schedules. Run configuration -- model, thinking level, active
 * tools -- is not here: it is native conversation state, set atomically by `configure`.
 */

/**
 * A branch entry keeps its identity even when it is not a message, because the
 * retry path rewinds to `parentId` and forking clones by `id` -- both need the
 * non-message entries to stay addressable.
 */
export type BranchEntry = {
  readonly id: string;
  readonly parentId: string | null;
} & ({ readonly type: "message"; readonly message: SessionMessage } | { readonly type: "other" });

export interface SessionLog {
  readBranch(): Promise<readonly BranchEntry[]>;

  /** `null` rewinds to the root, which is how a full transcript replace starts. */
  moveTo(entryId: string | null): Promise<void>;

  /** Returns the new entry id. */
  appendMessage(message: SessionMessage): Promise<string>;

  /** Idempotent: `finalizeRun` closes on paths where the open may have failed. */
  close(): Promise<void>;
}
