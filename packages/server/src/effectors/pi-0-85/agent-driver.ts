import {
  estimateContextTokens,
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  parseCommandArgs,
  type AgentHarness,
  type AgentLane,
  type Context,
  type ExecutionToolContext,
  type HarnessEvent,
  type HarnessEventType,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { errorMessage } from "../../errors.ts";
import type { AgentDriver, DriverResources, PromptDispatcher } from "../contracts/agent-driver.ts";
import {
  decideCompaction,
  PI_COMPACTION_SETTINGS,
  type CompactionOutcome,
  type CompactionSettings,
} from "../compaction-policy.ts";
import type { SessionLog } from "../contracts/session-log.ts";

/**
 * `AgentDriver` over Pi 0.85's `AgentHarness`.
 *
 * This file is the blast radius, and 0.85 is what it was built for. The v2
 * harness split in two: `AgentHarness` keeps session-scoped configuration,
 * while everything that drives a conversation -- prompt, skill, template,
 * compact, abort -- moved onto `AgentLane`. Every method also gained a trailing
 * `Context`, `AgentHarnessEvent` stopped being exported, and `subscribe()`
 * became `events.on(type, listener)`. All of it stops here.
 */

/** The session-scoped surface actually used, so a type error names what moved. */
export type PiHarness = Pick<AgentHarness<ExecutionToolContext>, "getResources" | "events">;

/** The lane-scoped surface actually used. Everything that runs the loop is here now. */
export type PiLane = Pick<AgentLane, "prompt" | "skill" | "promptFromTemplate" | "compact">;

/** The lane surface that carries per-run configuration, which 0.85 moved off the session tree. */
export type PiConfigLane = Pick<
  AgentLane,
  "getModel" | "setModel" | "getThinkingLevel" | "setThinkingLevel" | "getActiveTools" | "setActiveTools"
>;

export type PiDriverOptions = {
  harness: PiHarness;
  lane: PiLane;
  /** The run's invocation context. Carries the abort signal the harness observes. */
  context: Context;
  /** Read for context pressure; the lane owns the compaction itself. */
  log: Pick<SessionLog, "readBranch">;
  model: Model<Api>;
  /** Defaults to Pi's; overridden in tests to reach the edge cases cheaply. */
  settings?: CompactionSettings;
  /** Present only so tests can drive pressure without a real transcript. */
  estimateTokens?: (log: Pick<SessionLog, "readBranch">) => Promise<number>;
};

export type PiDispatcherOptions = { harness: PiHarness; lane: PiLane; context: Context };

/**
 * Dispatch-only slice. Separate from the full driver because it needs nothing
 * but the harness and its lane -- no model, no session log -- so every caller
 * that merely sends a prompt can be handed one without pretending to own a run.
 */
export function createPiPromptDispatcher({ harness, lane, context }: PiDispatcherOptions): PromptDispatcher {
  return {
    async listResources(): Promise<DriverResources> {
      const resources = await harness.getResources(context);
      return {
        skills: resources.skills ?? [],
        promptTemplates: resources.promptTemplates ?? [],
      };
    },

    async prompt(text, images) {
      await lane.prompt(text, images, context);
    },

    async invokeSkill(name, instructions, images) {
      // The native call takes text only, so an attachment forces the invocation
      // to be inlined as a prompt instead. Pi's own formatter is used so the
      // inlined form matches what `lane.skill` would have produced.
      if (images?.length) {
        const resources = await harness.getResources(context);
        const skill = resources.skills?.find((candidate) => candidate.name === name);
        if (!skill) throw new Error(`Skill not loaded: ${name}`);
        await lane.prompt(formatSkillInvocation(skill, instructions), images, context);
        return;
      }
      await lane.skill(name, instructions, context);
    },

    async invokeTemplate(name, args, images) {
      if (images?.length) {
        const resources = await harness.getResources(context);
        const template = resources.promptTemplates?.find((candidate) => candidate.name === name);
        if (!template) throw new Error(`Prompt template not loaded: ${name}`);
        await lane.prompt(formatPromptTemplateInvocation(template, parseCommandArgs(args)), images, context);
        return;
      }
      await lane.promptFromTemplate(name, parseCommandArgs(args), context);
    },
  };
}

/**
 * The harness event types Carmel projects onto the wire.
 *
 * 0.85's event bus has no wildcard: `events.on` takes one type. Listing them is
 * the price, and the gain is that the run no longer receives -- and immediately
 * drops -- every config, usage, queue and lane event the harness emits.
 */
const OBSERVED_EVENTS = [
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_end",
  "turn_end",
  "run_end",
  // Not projected onto the wire -- nothing renders it -- but the run needs to
  // know when Pi has spent its own overflow recovery, so that Carmel's does not
  // pay for the same compaction twice.
  "compaction_end",
] as const satisfies readonly HarnessEventType[];

/**
 * Subscribe to every harness event Carmel projects, as one handle.
 *
 * 0.85 replaced `harness.subscribe(fn)` with `events.on(type, fn)` and offers no
 * wildcard, so a caller that wants the stream has to name the types and unwind
 * a list of unsubscribes.
 */
export function observeHarnessEvents(
  harness: PiHarness,
  listener: (event: HarnessEvent) => void,
): () => void {
  const unsubscribes = OBSERVED_EVENTS.map((type) => harness.events.on(type, (event) => listener(event)));
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

export function createPiAgentDriver(options: PiDriverOptions): AgentDriver {
  const { harness, lane, context, model } = options;
  const estimate = options.estimateTokens ?? estimateFromBranch;

  return {
    ...createPiPromptDispatcher({ harness, lane, context }),

    async relieveContextPressure({ force = false } = {}): Promise<CompactionOutcome> {
      const settings = options.settings ?? PI_COMPACTION_SETTINGS;
      const decision = decideCompaction({
        tokens: await estimate(options.log),
        contextWindow: model.contextWindow,
        settings,
      });

      if (decision.action === "none" && !force) {
        return { status: "not_needed", tokens: decision.tokens, headroom: decision.headroom };
      }
      if (decision.action === "impossible") {
        return {
          status: "impossible",
          tokens: decision.tokens,
          headroom: decision.headroom,
          reason: decision.reason,
        };
      }

      const tokensBefore = decision.tokens;
      try {
        await lane.compact(undefined, context);
      } catch (error) {
        // "Nothing to compact" is Pi telling us the branch has no history old
        // enough to summarize, which is a state of the session and not a fault.
        // It used to reach the log as a compaction failure.
        if (isNothingToCompact(error)) {
          return { status: "nothing_to_compact", tokens: tokensBefore, headroom: decision.headroom };
        }
        return {
          status: "failed",
          tokens: tokensBefore,
          headroom: decision.headroom,
          code: harnessErrorCode(error),
          reason: errorMessage(error),
        };
      }

      // Re-measure rather than trust the call. Pi returns `tokensBefore` and no
      // "after", and a compaction that succeeds without buying enough room is
      // the failure mode that repeats -- silently, once per turn, at the cost of
      // a summarization call each time.
      const tokensAfter = await estimate(options.log);
      const status = tokensAfter > decision.headroom ? "ineffective" : "compacted";
      return { status, tokensBefore, tokensAfter, headroom: decision.headroom };
    },
  };
}

/**
 * Write the run configuration onto the lane where it differs.
 *
 * 0.85 moved model, thinking level and active tools out of the session tree and
 * onto lane state, so this is no longer an append. It still has to run: the
 * options handed to `AgentHarness.create` seed a *new* lane, but a restored one
 * keeps whatever it was last configured with and ignores them.
 */
export async function reconcileLaneConfiguration(
  lane: PiConfigLane,
  context: Context,
  desired: { model: Model<Api>; thinkingLevel: Parameters<AgentLane["setThinkingLevel"]>[0]; activeToolNames: string[] },
) {
  const current = await lane.getModel(context);
  if (current?.provider !== desired.model.provider || current.id !== desired.model.id) {
    await lane.setModel({ provider: desired.model.provider, modelId: desired.model.id }, context);
  }
  if ((await lane.getThinkingLevel(context)) !== desired.thinkingLevel) {
    await lane.setThinkingLevel(desired.thinkingLevel, context);
  }
  const activeTools = await lane.getActiveTools(context);
  if (!sameOrder(activeTools, desired.activeToolNames)) {
    await lane.setActiveTools(desired.activeToolNames, context);
  }
}

function sameOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Pi throws a compaction error carrying this message for an unsummarizable branch. */
function isNothingToCompact(error: unknown) {
  return /nothing to compact/i.test(errorMessage(error));
}

function harnessErrorCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

async function estimateFromBranch(log: Pick<SessionLog, "readBranch">) {
  const messages = (await log.readBranch()).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  return estimateContextTokens(messages).tokens;
}
