import type { AgentRunEvent, PromptInput } from "@carmel-agent/shared";
import type { CompactionOutcome } from "../compaction-policy.ts";

/**
 * What Carmel needs an agent loop to do, expressed without naming one.
 *
 * Pi's `AgentHarness` is the only implementation today (`../pi-0-83`), but it is
 * mid-rewrite upstream: v2 makes `AgentHarness` an interface, threads an
 * explicit `Context` through every method, unexports `AgentHarnessEvent`, and
 * replaces `subscribe()` with `events.on()`. None of that is visible here, which
 * is the point -- the port is the list of things Carmel actually asks for, and
 * it is deliberately shorter than the surface Pi offers.
 */

export type PromptImages = PromptInput["images"];

/** Names only: dispatch matches on them, and nothing here renders a skill body. */
export type DriverResources = {
  readonly skills: readonly { readonly name: string }[];
  readonly promptTemplates: readonly { readonly name: string }[];
};

/**
 * Compaction reports rather than throws, and its outcome type lives in
 * `../compaction-policy.ts` because deciding what an outcome means is policy,
 * not something an adapter should each get its own opinion about.
 */
/**
 * The two things Carmel reads off the event stream. Anything else Pi emits is
 * the adapter's business.
 *
 * `onUserMessagePersisted` exists for the retry path: a retry rewinds the branch
 * before re-sending, so until the replacement user message lands the original
 * branch is the only copy. That signal is the difference between "restore the
 * old branch" and "leave it rewound", and it must not depend on Pi's event
 * union staying exported.
 */
export interface AgentRunObserver {
  onRunEvent(event: AgentRunEvent): void;
  onUserMessagePersisted(): void;
}

export interface AgentDriver {
  /** Synchronous: dispatch decisions happen between an abort check and a prompt. */
  listResources(): DriverResources;

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

  /** Returns the unsubscribe handle. Safe to call after the run has finished. */
  observe(observer: AgentRunObserver): () => void;

  abort(): Promise<void>;

  /**
   * Bring the session back under its context budget if it is over it.
   *
   * Called before a prompt as well as after one. The pre-flight call is not
   * redundant: a session can be over budget at the start of a turn without
   * having grown -- switching it onto a model with a smaller window is enough,
   * and Carmel lets that happen per session -- and discovering it after the
   * prompt has already been rejected is too late to do anything about.
   */
  relieveContextPressure(): Promise<CompactionOutcome>;
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
