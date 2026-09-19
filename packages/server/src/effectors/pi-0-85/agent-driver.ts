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
import type { DriverResources, PromptDispatcher } from "../contracts/agent-driver.ts";
import type { SessionLog } from "../contracts/session-log.ts";

/**
 * The loop-facing half of the Pi 0.85 adapter: prompt dispatch, event
 * subscription, and lane configuration. `AgentHarness` keeps session-scoped
 * configuration; everything that drives a conversation lives on `AgentLane`.
 */

/** The session-scoped surface actually used, so a type error names what moved. */
export type PiHarness = Pick<AgentHarness<ExecutionToolContext>, "getResources" | "events">;

/** The lane-scoped surface actually used. Everything that runs the loop is here now. */
export type PiLane = Pick<AgentLane, "prompt" | "skill" | "promptFromTemplate">;

/** The lane surface that carries per-run configuration, which 0.85 moved off the session tree. */
export type PiConfigLane = Pick<
  AgentLane,
  "getModel" | "setModel" | "getThinkingLevel" | "setThinkingLevel" | "getActiveTools" | "setActiveTools"
>;

export type PiDispatcherOptions = { harness: PiHarness; lane: PiLane; context: Context };

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

/** Pi's own estimate of the branch's size, for the pre-flight notice. */
export async function estimateBranchTokens(log: Pick<SessionLog, "readBranch">) {
  const messages = (await log.readBranch()).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  return estimateContextTokens(messages).tokens;
}
