import type { AgentThinkingLevel } from "@carmel-agent/shared";
import type { SessionMessage } from "./messages.ts";

/**
 * The session tree, as Carmel uses it.
 *
 * This is the second port, and it is separate from `AgentDriver` on purpose:
 * upstream reshapes the loop and the store on independent schedules, and 0.84
 * already renames most of this surface underneath us --
 * `moveTo` -> `moveLane`/`navigateTree`, `getBranch()` -> `findEntriesOnBranch()`,
 * `SessionTreeEntry` -> `Entry`, `session.buildContext()` -> a standalone
 * `buildSessionContext(entries)`, and `getStorage()` going private. Every one of
 * those is a rename of something named here exactly once.
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

/** The configuration the log already believes it is under, for change detection. */
export type SessionState = {
  readonly model: { readonly provider: string; readonly modelId: string } | null;
  /**
   * Never null: a session is always running at some effective level, and an
   * unconfigured one is running at `"off"`. Modelling it as nullable made the
   * contract suite fail against the real adapter, because Pi reports the default
   * while an in-memory stand-in reported "unset" -- and a caller comparing
   * against `"off"` would then append a redundant change entry on the first turn
   * of every new session.
   */
  readonly thinkingLevel: AgentThinkingLevel;
  readonly activeToolNames: readonly string[] | null;
};

export interface SessionLog {
  readBranch(): Promise<readonly BranchEntry[]>;

  /** `null` rewinds to the root, which is how a full transcript replace starts. */
  moveTo(entryId: string | null): Promise<void>;

  /** Returns the new entry id. */
  appendMessage(message: SessionMessage): Promise<string>;

  readState(): Promise<SessionState>;

  appendModelChange(provider: string, modelId: string): Promise<void>;
  appendThinkingLevelChange(level: AgentThinkingLevel): Promise<void>;
  appendActiveToolsChange(names: readonly string[]): Promise<void>;

  /** Idempotent: `finalizeRun` closes on paths where the open may have failed. */
  close(): Promise<void>;
}

/**
 * Write the run configuration only where it differs from what the log already
 * records. Pure policy over the port -- no implementation of `SessionLog` gets a
 * say in what counts as a change, and no adapter has to re-derive it.
 */
export async function reconcileSessionState(
  log: SessionLog,
  desired: {
    model: { provider: string; modelId: string };
    thinkingLevel: AgentThinkingLevel;
    activeToolNames: readonly string[];
  },
): Promise<void> {
  const state = await log.readState();
  if (state.model?.provider !== desired.model.provider || state.model.modelId !== desired.model.modelId) {
    await log.appendModelChange(desired.model.provider, desired.model.modelId);
  }
  if (state.thinkingLevel !== desired.thinkingLevel) {
    await log.appendThinkingLevelChange(desired.thinkingLevel);
  }
  if (!sameOrder(state.activeToolNames, desired.activeToolNames)) {
    await log.appendActiveToolsChange(desired.activeToolNames);
  }
}

function sameOrder(left: readonly string[] | null, right: readonly string[]) {
  return Boolean(left && left.length === right.length && left.every((value, index) => value === right[index]));
}
