import type { PromptInput } from "@carmel-agent/shared";
import type { CompactionOutcome } from "../compaction-policy.ts";

/**
 * What Carmel needs an agent loop to do, expressed without naming one.
 * Pi's `AgentHarness` is the only implementation (`../pi-0-85`).
 */

export type PromptImages = PromptInput["images"];

/** Names only: dispatch matches on them, and nothing here renders a skill body. */
export type DriverResources = {
  readonly skills: readonly { readonly name: string }[];
  readonly promptTemplates: readonly { readonly name: string }[];
};

export interface AgentDriver {
  /**
   * Async since Pi 0.85, where reading the harness's resources became a call
   * that takes an invocation `Context`. Dispatch was already async, so this
   * costs one `await` at the single call site.
   */
  listResources(): Promise<DriverResources>;

  prompt(text: string, images?: PromptImages): Promise<void>;

  /**
   * Named invocation of a loaded skill or template. Images are passed here
   * rather than handled by the caller because whether a driver can carry an
   * attachment through a named invocation -- or has to inline the invocation as
   * prompt text instead -- is a property of the driver, not of Carmel's
   * slash-command rules.
   */
  invokeSkill(name: string, instructions: string | undefined, images?: PromptImages): Promise<void>;
  invokeTemplate(name: string, args: string, images?: PromptImages): Promise<void>;

  /**
   * Bring the session back under its context budget if it is over it.
   *
   * Called before a prompt -- a session can be over budget at the start of a
   * turn without having grown, since switching it onto a model with a smaller
   * window is enough -- and again, forced, when recovering from an overflow.
   * Reports rather than throws; what an outcome means is policy, in
   * `../compaction-policy.ts`.
   *
   * `force` compacts even when the local estimate says there is room. It exists
   * for the case where the provider has already rejected the request as too
   * large: `estimateContextTokens` is a character heuristic, the provider's own
   * count is ground truth, and without this the recovery path would consult the
   * estimate that was just proven wrong and decline to act. It does not override
   * an `impossible` verdict, which is about the model rather than the estimate.
   */
  relieveContextPressure(options?: { readonly force?: boolean }): Promise<CompactionOutcome>;
}

/**
 * The slice of the driver that slash-command dispatch needs.
 *
 * Effectors compose rather than nest: dispatch has no business holding a handle
 * that can abort a run or compact a session, and a caller that only dispatches
 * should not have to supply the model and session log that compaction requires.
 */
export type PromptDispatcher = Pick<
  AgentDriver,
  "listResources" | "prompt" | "invokeSkill" | "invokeTemplate"
>;
