import type { PromptInput } from "@carmel-agent/shared";

/**
 * What Carmel needs an agent loop to do, expressed without naming one: send
 * composer text, as a plain prompt or a named skill or template. Compaction is
 * not here -- Pi does it, and Carmel only reports on it.
 * Pi's `AgentHarness` is the only implementation (`../pi-0-85`).
 */

export type PromptImages = PromptInput["images"];

/** Names only: dispatch matches on them, and nothing here renders a skill body. */
export type DriverResources = {
  readonly skills: readonly { readonly name: string }[];
  readonly promptTemplates: readonly { readonly name: string }[];
};

export interface PromptDispatcher {
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
}
